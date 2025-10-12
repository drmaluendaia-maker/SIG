// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini
// Versión: 3.8 (Nuevas Funcionalidades de Flujo de Trabajo y Correcciones)
// =================================================================================

// 1. IMPORTACIONES Y CONFIGURACIÓN BÁSICA
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const os = require('os');
const fs = require('fs');
const open = require('open');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

const DATA_DIR = process.env.RENDER_DISK_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)){ fs.mkdirSync(DATA_DIR, { recursive: true }); }

const DB_FILE = path.join(DATA_DIR, 'pacientes.json');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const ADMIN_MASTER_PASS = "SIGadmin2025";

app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));

// 2. ESTADO DE LA APLICACIÓN
let patients = [];
let attendedHistory = [];
let users = [];
let observationPresets = [];
let isEmergency = false;
let currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };
let activeShifts = {};

// 3. PERSISTENCIA DE DATOS
const saveData = () => { fs.writeFile(DB_FILE, JSON.stringify({ patients, attendedHistory }, null, 2), err => { if (err) console.error("Error al guardar pacientes:", err); }); };
const saveUsers = () => { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), err => { if (err) console.error("Error al guardar usuarios:", err); }); };
const savePresets = () => { fs.writeFile(PRESETS_FILE, JSON.stringify(observationPresets, null, 2), err => { if (err) console.error("Error al guardar presets:", err); }); };

const loadData = () => {
    try {
        if (fs.existsSync(DB_FILE)) { const fileData = fs.readFileSync(DB_FILE); const data = JSON.parse(fileData.length ? fileData : '{}'); patients = data.patients || []; attendedHistory = data.attendedHistory || []; } else { fs.writeFileSync(DB_FILE, JSON.stringify({ patients: [], attendedHistory: [] }, null, 2)); }
        if (!fs.existsSync(USERS_FILE)) {
            const defaultUsers = [ { user: "admin", pass: "admin2025", role: "registro", fullName: "Enfermería de Triage", token: "a1" }, { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. Gregory House", token: "b2" }, { user: "enfguardia", pass: "enf123", role: "enfermero_guardia", fullName: "Enfermería de Guardia", token: "c3" }, { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia", token: "d4" } ];
            fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        }
        users = JSON.parse(fs.readFileSync(USERS_FILE));
        if (!fs.existsSync(PRESETS_FILE)) {
            const defaultPresets = [ { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico opresivo", level: "naranja" }, { text: "Crisis asmática", level: "amarillo" } ];
            fs.writeFileSync(PRESETS_FILE, JSON.stringify(defaultPresets, null, 2));
        }
        observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE));
        console.log("✔️  Datos cargados correctamente.");
    } catch (err) { console.error("❌  Error crítico al cargar datos:", err.message); process.exit(1); }
};

// 4. FUNCIONES DE UTILIDAD
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
const logAction = (patientId, type, details, user) => {
    const patient = patients.find(p => p.id === patientId) || attendedHistory.find(p => p.id === patientId);
    if (patient) {
        if (!patient.log) patient.log = [];
        patient.log.push({ id: crypto.randomUUID(), timestamp: Date.now(), type, user: user.fullName, details });
        if (activeShifts[user.user]) { activeShifts[user.user].managedPatientIds.add(patientId); }
    }
};

// 5. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;
    let isAuthenticated = false;

    // --- AUTENTICACIÓN ---
    const authenticate = (user) => {
        currentUser = user;
        isAuthenticated = true;
        socket.emit('auth_success', user);
        console.log(`Usuario conectado: ${user.user} (${user.role})`);
        socket.emit('presets_update', observationPresets);
    };
    socket.on('authenticate_user', ({ user, pass }) => { const foundUser = users.find(u => u.user === user && u.pass === pass); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    socket.on('authenticate_token', (token) => { const foundUser = users.find(u => u.token === token); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    
    socket.on('admin_login', ({pass}) => { /* ... (sin cambios) */ });
    
    // --- GESTIÓN DE GUARDIA ---
    socket.on('start_shift', () => { if (!isAuthenticated) return; activeShifts[currentUser.user] = { user: currentUser, startTime: Date.now(), managedPatientIds: new Set() }; });
    socket.on('end_shift', (callback) => { if (!isAuthenticated || !activeShifts[currentUser.user]) return; const shift = activeShifts[currentUser.user]; const attendedInShift = [...attendedHistory, ...patients].filter(p => shift.managedPatientIds.has(p.id)); delete activeShifts[currentUser.user]; callback({ user: currentUser, startTime: shift.startTime, endTime: Date.now(), attendedPatients: attendedInShift }); });

    // --- EVENTOS DE PACIENTES ---
    const patientEvents = {
        'register_patient': (newPatient) => { if (currentUser.role !== 'registro') return; newPatient.log = []; patients.push(newPatient); sortPatients(); logAction(newPatient.id, 'Registro', `Motivo: ${newPatient.notas}`, currentUser); },
        
        // --- NUEVO: Evento de Reevaluación ---
        'update_patient_details': ({ id, newNotes, newVitals }) => {
            if (currentUser.role !== 'registro') return;
            const patient = patients.find(p => p.id === id);
            if (patient) {
                if (newNotes) {
                    patient.notas += `; ${newNotes}`;
                    logAction(id, 'Reevaluación (Nota)', newNotes, currentUser);
                }
                if (newVitals && Object.values(newVitals).some(v => v)) {
                    Object.assign(patient.vitals, newVitals); // Sobrescribe solo los vitales nuevos
                    logAction(id, 'Reevaluación (Vitales)', `Nuevos vitales registrados.`, currentUser);
                }
            }
        },

        'update_patient_level': ({ id, newLevel }) => { /* ... (sin cambios) */ },
        'send_to_nursing': ({ patientId }) => { /* ... (sin cambios) */ },
        'call_patient': ({ id, consultorio }) => { /* ... (sin cambios) */ },
        'add_doctor_note': ({ id, note }) => { if (currentUser.role !== 'medico') return; logAction(id, 'Nota Médica', note, currentUser); },
        'add_indication': ({ id, text }) => { if (currentUser.role !== 'medico') return; const patient = patients.find(p => p.id === id); if (patient) { if (!patient.indications) patient.indications = []; const newIndication = { id: crypto.randomUUID(), text, doctor: currentUser.fullName, status: 'pendiente', timestamp: Date.now() }; patient.indications.push(newIndication); logAction(id, 'Indicación Médica', text, currentUser); } },
        'update_indication_status': ({ patientId, indicationId }) => { /* ... (sin cambios) */ },
        'update_patient_status': ({ id, status }) => { if (currentUser.role !== 'medico') return; const p = patients.find(p => p.id === id); if (p) { p.status = status; logAction(id, 'Cambio de Estado', `Paciente pasa a: ${status}.`, currentUser); } },
        
        // --- NUEVO: Evento de Traslado ---
        'transfer_patient': ({ patientId, transferData }) => {
            if (currentUser.role !== 'medico') return;
            const patientIndex = patients.findIndex(p => p.id === patientId);
            if (patientIndex > -1) {
                const [patient] = patients.splice(patientIndex, 1);
                patient.attendedAt = Date.now();
                patient.disposition = 'Trasladado';
                patient.transferData = transferData; // Se guarda el objeto completo
                attendedHistory.push(patient);
                logAction(patientId, 'Alta por Traslado', `Trasladado a ${transferData.lugar}. Receptor: ${transferData.medicoReceptor}.`, currentUser);
            }
        },
        
        'mark_as_attended': ({ patientId }) => { /* ... (sin cambios) */ },
    };

    for (const eventName in patientEvents) {
        socket.on(eventName, (data) => {
            if (!isAuthenticated) return;
            patientEvents[eventName](data);
            saveData();
            io.emit('update_patient_list', patients);
            io.emit('attended_history_update', attendedHistory);
        });
    }

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// 6. INICIO DEL SERVIDOR
const DEPLOY_PORT = process.env.PORT || PORT;
server.listen(DEPLOY_PORT, '0.0.0.0', () => {
    loadData();
    console.log(`✔️  Servidor SIG v3.8 escuchando en el puerto ${DEPLOY_PORT}`);
    if (!process.env.RENDER) { open(`http://localhost:${PORT}`); }
});
