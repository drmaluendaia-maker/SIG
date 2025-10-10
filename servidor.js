// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini
// Versión: 3.3 (Re-ingeniería y Corrección de Errores)
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
let activeShifts = {}; // { username: { user, startTime, managedPatientIds: Set } }

// 3. PERSISTENCIA DE DATOS
const saveData = () => { fs.writeFile(DB_FILE, JSON.stringify({ patients, attendedHistory }, null, 2), err => { if (err) console.error("Error al guardar pacientes:", err); }); };
const saveUsers = () => { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), err => { if (err) console.error("Error al guardar usuarios:", err); }); };
const savePresets = () => { fs.writeFile(PRESETS_FILE, JSON.stringify(observationPresets, null, 2), err => { if (err) console.error("Error al guardar presets:", err); }); };

const loadData = () => {
    try {
        if (fs.existsSync(DB_FILE)) { const data = JSON.parse(fs.readFileSync(DB_FILE)); patients = data.patients || []; attendedHistory = data.attendedHistory || []; }
        if (fs.existsSync(USERS_FILE)) { users = JSON.parse(fs.readFileSync(USERS_FILE)); } else {
            users = [
                { user: "admin", pass: "admin2025", role: "registro", fullName: "Enfermería de Triage" },
                { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. Gregory House" },
                { user: "enfguardia", pass: "enf123", role: "enfermero_guardia", fullName: "Enfermería de Guardia" },
                { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia" }
            ];
            saveUsers();
        }
        users.forEach(u => { if (!u.token) u.token = crypto.randomBytes(16).toString('hex'); });
        saveUsers();
        if (fs.existsSync(PRESETS_FILE)) { observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE)); } else {
            observationPresets = [
                { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico opresivo", level: "naranja" },
                { text: "Crisis asmática", level: "amarillo" }, { text: "Tos y mocos", level: "verde" }
            ];
            savePresets();
        }
        console.log("✔️  Datos cargados correctamente.");
    } catch (err) { console.error("❌  Error crítico al cargar datos:", err); }
};

// 4. FUNCIONES DE UTILIDAD
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
// --- NUEVA FUNCIÓN: Log de Acciones Centralizado ---
const logAction = (patientId, type, details, user) => {
    const patient = patients.find(p => p.id === patientId) || attendedHistory.find(p => p.id === patientId);
    if (patient) {
        if (!patient.log) patient.log = [];
        patient.log.push({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            type,
            user: user.fullName,
            details
        });
        // --- NUEVO: Registrar actividad en la guardia activa ---
        if (activeShifts[user.user]) {
            activeShifts[user.user].managedPatientIds.add(patientId);
        }
    }
};

// 5. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;

    const authenticate = (user) => {
        currentUser = user;
        socket.emit('auth_success', user);
        console.log(`Usuario conectado: ${user.user} (${user.role})`);
        // --- CORRECCIÓN: Asegurar que los presets se envíen al autenticar ---
        socket.emit('presets_update', observationPresets);
    };

    socket.on('authenticate_user', ({ user, pass }) => { const foundUser = users.find(u => u.user === user && u.pass === pass); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    socket.on('authenticate_token', (token) => { const foundUser = users.find(u => u.token === token); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    
    // --- Lógica de Administración (sin cambios) ---
    socket.on('admin_login', ({pass}) => { if (pass === ADMIN_MASTER_PASS) { currentUser = { role: 'admin', fullName: 'SuperAdmin' }; socket.emit('admin_auth_success', {}); socket.emit('users_update', users); socket.emit('presets_update', observationPresets); } else { socket.emit('auth_fail'); }});
    // ... (El resto de la lógica de admin no cambia)

    // --- GESTIÓN DE GUARDIA ---
    socket.on('start_shift', () => { if (!currentUser) return; activeShifts[currentUser.user] = { user: currentUser, startTime: Date.now(), managedPatientIds: new Set() }; console.log(`Guardia INICIADA por ${currentUser.user}`); });
    socket.on('end_shift', (callback) => {
        if (!currentUser || !activeShifts[currentUser.user]) return;
        const shift = activeShifts[currentUser.user];
        const attendedInShift = [...attendedHistory, ...patients].filter(p => shift.managedPatientIds.has(p.id));
        delete activeShifts[currentUser.user];
        console.log(`Guardia FINALIZADA por ${currentUser.user}`);
        callback({ user: currentUser, startTime: shift.startTime, endTime: Date.now(), attendedPatients: attendedInShift });
    });

    // --- EVENTOS DE PACIENTES ---
    const setupPatientEvents = () => {
        const events = {
            'register_patient': (newPatient) => {
                if (currentUser.role !== 'registro') return;
                newPatient.log = [];
                patients.push(newPatient);
                sortPatients();
                logAction(newPatient.id, 'Registro', `Paciente registrado con nivel ${newPatient.nivelTriage}.`, currentUser);
                io.emit('new_patient_notification', { patient: newPatient });
            },
            'update_patient_level': ({ id, newLevel }) => {
                if (currentUser.role !== 'registro') return;
                const p = patients.find(p => p.id === id);
                if (p) {
                    const oldLevel = p.nivelTriage;
                    p.nivelTriage = newLevel;
                    p.ordenTriage = triageOrder[newLevel];
                    sortPatients();
                    logAction(id, 'Re-Triage', `Nivel cambiado de ${oldLevel} a ${newLevel}.`, currentUser);
                }
            },
            'send_to_nursing': ({ patientId }) => {
                if (currentUser.role !== 'registro') return;
                const patient = patients.find(p => p.id === patientId);
                if (patient) {
                    patient.status = 'pre_internacion';
                    logAction(patientId, 'Derivación', 'Enviado directamente a enfermería de guardia.', currentUser);
                }
            },
            'call_patient': ({ id, consultorio }) => {
                if (currentUser.role !== 'medico') return;
                const p = patients.find(p => p.id === id);
                if (p) {
                    p.status = 'atendiendo';
                    p.consultorio = consultorio;
                    p.doctor_user = currentUser.user;
                    logAction(id, 'Llamado', `Llamado a consultorio ${consultorio}.`, currentUser);
                    currentlyCalled = { nombre: p.nombre, consultorio };
                    io.emit('update_call', currentlyCalled);
                    setTimeout(() => { currentlyCalled = null; io.emit('update_call', null); }, 20000);
                }
            },
            'add_nurse_evolution': ({ id, note }) => {
                if (currentUser.role !== 'registro' && currentUser.role !== 'enfermero_guardia') return;
                logAction(id, 'Nota de Enfermería', note, currentUser);
            },
            'add_doctor_note': ({ id, note }) => {
                if (currentUser.role !== 'medico') return;
                logAction(id, 'Nota Médica', note, currentUser);
            },
            'add_indication': ({ id, text }) => {
                if (currentUser.role !== 'medico') return;
                const patient = patients.find(p => p.id === id);
                if (patient) {
                    if (!patient.indications) patient.indications = [];
                    const newIndication = { id: crypto.randomUUID(), text, doctor: currentUser.fullName, status: 'pendiente', timestamp: Date.now() };
                    patient.indications.push(newIndication);
                    logAction(id, 'Indicación Médica', text, currentUser);
                }
            },
            'update_indication_status': ({ patientId, indicationId }) => {
                if (currentUser.role !== 'enfermero_guardia') return;
                const patient = patients.find(p => p.id === patientId);
                const indication = patient?.indications.find(i => i.id === indicationId);
                if (indication) {
                    indication.status = 'realizada';
                    indication.completedBy = currentUser.fullName;
                    indication.completedAt = Date.now();
                    logAction(patientId, 'Indicación Cumplida', indication.text, currentUser);
                }
            },
            'mark_as_attended': ({ patientId }) => {
                const patientIndex = patients.findIndex(p => p.id === patientId);
                if (patientIndex > -1) {
                    const [patient] = patients.splice(patientIndex, 1);
                    patient.attendedAt = Date.now();
                    patient.disposition = 'Alta';
                    attendedHistory.push(patient);
                    logAction(patientId, 'Alta Médica', `Paciente dado de alta.`, currentUser);
                }
            },
            // ... (Otros eventos como 'hospitalize', 'transfer', 'update_patient_status' se modificarían de forma similar para usar logAction)
        };

        for (const eventName in events) {
            socket.on(eventName, (data) => {
                if (!currentUser) return;
                events[eventName](data);
                saveData();
                io.emit('update_patient_list', patients);
                io.emit('attended_history_update', attendedHistory);
            });
        }
    };
    setupPatientEvents();

    // Emisiones iniciales al cliente
    socket.emit('update_patient_list', patients);
    socket.emit('attended_history_update', attendedHistory);

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// 6. INICIO DEL SERVIDOR
const DEPLOY_PORT = process.env.PORT || PORT;
server.listen(DEPLOY_PORT, '0.0.0.0', () => {
    loadData();
    console.log(`✔️  Servidor SIG v3.3 escuchando en el puerto ${DEPLOY_PORT}`);
    if (!process.env.RENDER) { open(`http://localhost:${PORT}`); }
});
