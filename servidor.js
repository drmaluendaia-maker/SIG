// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini
// Versión: 3.0 (Preparado para Despliegue)
// =================================================================================

// 1. IMPORTACIONES Y CONFIGURACIÓN BÁSICA
// =================================================================================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const os = require('os');
const fs = require('fs');
const open = require('open');
const crypto = require('crypto');
const path = require('path'); // Importamos 'path' para unir rutas de forma segura

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

// --- MODIFICACIÓN PARA RENDER ---
// Directorio para datos persistentes. Render montará un disco en esta ruta.
const DATA_DIR = path.join(__dirname, 'data'); 
// Asegurarnos de que el directorio de datos exista
if (!fs.existsSync(DATA_DIR)){
    fs.mkdirSync(DATA_DIR);
}

// Archivos de persistencia de datos apuntando a la nueva carpeta
const DB_FILE = path.join(DATA_DIR, 'pacientes.json');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');

const ADMIN_MASTER_PASS = "SIGadmin2025";

app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));


// 2. ESTADO DE LA APLICACIÓN (DATOS EN MEMORIA)
// =================================================================================
let patients = [];
let attendedHistory = [];
let users = [];
let observationPresets = [];
let isEmergency = false;
let currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };


// 3. PERSISTENCIA DE DATOS (LECTURA/ESCRITURA DE ARCHIVOS)
// =================================================================================
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
            saveUsers(); // Guardar usuarios por defecto si el archivo no existe
        }
        users.forEach(u => { if (!u.token) u.token = crypto.randomBytes(16).toString('hex'); });
        saveUsers();
        if (fs.existsSync(PRESETS_FILE)) { observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE)); } else {
            observationPresets = [
                { text: "Parada cardiorrespiratoria", level: "rojo" },
                { text: "Dolor torácico opresivo", level: "naranja" },
                { text: "Crisis asmática", level: "amarillo" },
                { text: "Tos y mocos", level: "verde" },
                { text: "Constatación de lesiones", level: "azul" }
            ];
            savePresets(); // Guardar presets por defecto si el archivo no existe
        }
        console.log("✔️  Datos (pacientes, usuarios, presets) cargados correctamente.");
    } catch (err) { console.error("❌  Error crítico al cargar datos:", err); }
};


// 4. FUNCIONES DE UTILIDAD (Sin cambios)
// =================================================================================
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
const getNurseShift = (date) => { const hour = date.getHours(); if (hour >= 7 && hour < 14) return "Mañana"; if (hour >= 14 && hour < 21) return "Tarde"; return "Noche"; };
const getDoctorGuard = (date) => { let guardDate = new Date(date); if (date.getHours() < 8) { guardDate.setDate(guardDate.getDate() - 1); } const dayName = guardDate.toLocaleDateString('es-ES', { weekday: 'long' }); return `Guardia del ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`; };


// 5. LÓGICA DE SOCKETS (Sin cambios en la lógica interna)
// =================================================================================
io.on('connection', (socket) => {
    // ... (Toda la lógica de sockets permanece exactamente igual que antes) ...
    let isAuthenticated = false;
    let currentUser = null;

    // --- A. Autenticación y Conexión Inicial ---
    const authenticateSocket = (user) => {
        isAuthenticated = true;
        currentUser = user;
        socket.emit('auth_success', user);
        console.log(`Usuario conectado: ${user.user} (${user.role})`);
    };

    socket.on('authenticate_user', ({ user, pass }) => {
        const foundUser = users.find(u => u.user === user && u.pass === pass);
        if (foundUser) authenticateSocket(foundUser);
        else socket.emit('auth_fail');
    });

    socket.on('authenticate_token', (token) => {
        const foundUser = users.find(u => u.token === token);
        if (foundUser) authenticateSocket(foundUser);
        else socket.emit('auth_fail');
    });
    
    socket.emit('update_patient_list', patients);
    socket.emit('emergency_status_update', isEmergency);
    socket.emit('update_call', currentlyCalled);
    socket.emit('presets_update', observationPresets);

    // --- B. Lógica del Panel de Administración ---
    socket.on('admin_login', ({pass, remember}) => {
        if (pass === ADMIN_MASTER_PASS) {
            isAuthenticated = true;
            currentUser = { role: 'admin' };
            const token = remember ? crypto.randomBytes(16).toString('hex') : null;
            socket.emit('admin_auth_success', {token});
            const displayUsers = [{ user: "superadmin", pass: "********", role: "admin", fullName: "Administrador Principal" }, ...users];
            socket.emit('users_update', displayUsers);
            socket.emit('presets_update', observationPresets);
        } else {
            socket.emit('auth_fail');
        }
    });

    const hasAdminPermission = () => isAuthenticated && currentUser && currentUser.role === 'admin';

    socket.on('get_users', () => {
        if (!hasAdminPermission()) return;
        const displayUsers = [{ user: "superadmin", pass: "********", role: "admin", fullName: "Administrador Principal" }, ...users];
        socket.emit('users_update', displayUsers);
    });
    
    socket.on('add_user', (newUser) => {
        if (hasAdminPermission() && newUser.user && newUser.pass && newUser.fullName && newUser.role) {
            if (!users.some(u => u.user === newUser.user) && newUser.user !== 'superadmin') {
                newUser.token = crypto.randomBytes(16).toString('hex');
                users.push(newUser);
                saveUsers();
                io.emit('users_update', [{ user: "superadmin", pass: "********", role: "admin", fullName: "Administrador Principal" }, ...users]);
            }
        }
    });

    socket.on('delete_user', (username) => {
        if (hasAdminPermission() && username !== 'superadmin') {
            users = users.filter(u => u.user !== username);
            saveUsers();
            io.emit('users_update', [{ user: "superadmin", pass: "********", role: "admin", fullName: "Administrador Principal" }, ...users]);
        }
    });

    socket.on('edit_user', ({ username, newFullName, newPassword }) => {
        if (hasAdminPermission() && username !== 'superadmin') {
            const userIndex = users.findIndex(u => u.user === username);
            if (userIndex > -1) {
                users[userIndex].fullName = newFullName;
                users[userIndex].pass = newPassword;
                saveUsers();
                io.emit('users_update', [{ user: "superadmin", pass: "********", role: "admin", fullName: "Administrador Principal" }, ...users]);
            }
        }
    });

    socket.on('reset_patient_data', () => {
        if (hasAdminPermission()) {
            patients = [];
            attendedHistory = [];
            saveData();
            io.emit('update_patient_list', patients);
            socket.emit('reset_success');
        }
    });

    // --- C. Lógica de Presets de Observaciones ---
     socket.on('add_preset', (newPreset) => {
        if (hasAdminPermission() && newPreset.text && newPreset.level && !observationPresets.some(p => p.text === newPreset.text)) {
            observationPresets.push(newPreset);
            savePresets();
            io.emit('presets_update', observationPresets);
        }
    });

    socket.on('delete_preset', (presetText) => {
        if (hasAdminPermission() && presetText) {
            observationPresets = observationPresets.filter(p => p.text !== presetText);
            savePresets();
            io.emit('presets_update', observationPresets);
        }
    });

    socket.on('edit_preset', ({ oldText, newText, newLevel }) => {
        if (hasAdminPermission()) {
            const presetIndex = observationPresets.findIndex(p => p.text === oldText);
            if (presetIndex > -1) {
                observationPresets[presetIndex] = { text: newText, level: newLevel };
                savePresets();
                io.emit('presets_update', observationPresets);
            }
        }
    });
    
    // --- D. Lógica de Pacientes y Flujo Clínico ---
    const setupPatientEvents = () => {
        const events = {
            'register_patient': (newPatient) => {
                if (currentUser.role !== 'registro') return;
                newPatient.registeredBy = currentUser.user;
                newPatient.shift = getNurseShift(new Date(newPatient.horaLlegada));
                patients.push(newPatient);
                sortPatients();
                io.emit('new_patient_notification', { patient: newPatient, patientCount: patients.length });
            },
            'update_patient_level': ({ id, newLevel }) => {
                 if (currentUser.role !== 'registro') return;
                const p = patients.find(p => p.id === id);
                if (p) { p.nivelTriage = newLevel; p.ordenTriage = triageOrder[newLevel]; sortPatients(); }
            },
            'call_patient': ({ id, consultorio }) => {
                if (currentUser.role !== 'medico') return;
                const currentlyAttending = patients.find(pt => pt.doctor_user === currentUser.user && pt.status === 'atendiendo');
                if (currentlyAttending) { 
                    currentlyAttending.status = currentlyAttending.previousStatus || 'en_espera';
                    delete currentlyAttending.consultorio;
                    delete currentlyAttending.doctor_user;
                    delete currentlyAttending.doctor_name;
                }
                const p = patients.find(p => p.id === id);
                if (p) {
                    p.previousStatus = p.status;
                    p.status = 'atendiendo';
                    p.consultorio = consultorio;
                    p.doctor_user = currentUser.user;
                    p.doctor_name = currentUser.fullName;
                    currentlyCalled = { nombre: p.nombre, consultorio };
                    io.emit('update_call', currentlyCalled);
                    setTimeout(() => { currentlyCalled = null; io.emit('update_call', null); }, 20000);
                }
            },
             'update_patient_status': ({ id, status }) => {
                if (currentUser.role !== 'medico') return;
                const p = patients.find(p => p.id === id);
                if (p) { p.status = status; if (status === 'ausente' || status === 'pre_internacion') { delete p.consultorio; } sortPatients(); }
            },
            'add_nurse_evolution': ({ id, note }) => {
                if (currentUser.role !== 'registro' && currentUser.role !== 'enfermero_guardia') return;
                const patient = patients.find(p => p.id === id) || attendedHistory.find(p => p.id === id);
                if (patient) {
                    if (!patient.nurseEvolutions) patient.nurseEvolutions = [];
                    patient.nurseEvolutions.push({ text: note, user: currentUser.fullName, timestamp: Date.now() });
                }
            },
            'add_doctor_note': ({ id, note }) => {
                if (currentUser.role !== 'medico') return;
                const patient = patients.find(p => p.id === id) || attendedHistory.find(p => p.id === id);
                if (patient) {
                    if (!patient.doctorNotes) patient.doctorNotes = [];
                    patient.doctorNotes.push({ text: note, doctor: currentUser.fullName, timestamp: Date.now() });
                }
            },
             'add_indication': ({ id, text }) => {
                if (currentUser.role !== 'medico') return;
                const patient = patients.find(p => p.id === id);
                if (patient) {
                    if (!patient.indications) patient.indications = [];
                    patient.indications.push({ id: crypto.randomUUID(), text, doctor: currentUser.fullName, status: 'pendiente', timestamp: Date.now() });
                }
            },
            'update_indication_status': ({ patientId, indicationId, newStatus }) => {
                if (currentUser.role !== 'enfermero_guardia') return;
                const patient = patients.find(p => p.id === patientId);
                if (patient && patient.indications) {
                    const indication = patient.indications.find(i => i.id === indicationId);
                    if (indication) {
                        indication.status = newStatus;
                        indication.completedBy = currentUser.fullName;
                        indication.completedAt = Date.now();
                    }
                }
            },
            'mark_as_attended': ({ patientId }) => {
                const patientIndex = patients.findIndex(p => p.id === patientId);
                if (patientIndex > -1) {
                    const [patient] = patients.splice(patientIndex, 1);
                    patient.attendedAt = Date.now();
                    patient.attendedBy = currentUser.fullName;
                    patient.guardDay = getDoctorGuard(new Date(patient.attendedAt));
                    patient.disposition = 'Alta';
                    attendedHistory.push(patient);
                }
            },
             'hospitalize_patient': ({ patientId, data }) => {
                if (currentUser.role !== 'medico') return;
                const patientIndex = patients.findIndex(p => p.id === patientId);
                if (patientIndex > -1) {
                    const [patient] = patients.splice(patientIndex, 1);
                    patient.attendedAt = Date.now(); patient.attendedBy = currentUser.fullName; patient.disposition = 'Internado'; patient.hospitalizationData = data;
                    attendedHistory.push(patient);
                }
            },
            'transfer_patient': ({ patientId, data }) => {
                 if (currentUser.role !== 'medico') return;
                const patientIndex = patients.findIndex(p => p.id === patientId);
                if (patientIndex > -1) {
                    const [patient] = patients.splice(patientIndex, 1);
                    patient.attendedAt = Date.now(); patient.attendedBy = currentUser.fullName; patient.disposition = 'Trasladado'; patient.transferData = data;
                    attendedHistory.push(patient);
                }
            },
            'continue_care': (patientId) => {
                 if (currentUser.role !== 'medico') return;
                const historyIndex = attendedHistory.findIndex(p => p.id === patientId);
                if (historyIndex > -1) {
                    const [patientToReactivate] = attendedHistory.splice(historyIndex, 1);
                    patientToReactivate.status = 'pre_internacion';
                    delete patientToReactivate.consultorio; delete patientToReactivate.doctor_user; delete patientToReactivate.doctor_name;
                    patients.push(patientToReactivate);
                    sortPatients();
                }
            },
            'add_observation_to_attended': ({ id, note }) => {
                const patient = attendedHistory.find(p => p.id === id);
                if (patient) {
                    if (currentUser.role === 'registro' || currentUser.role === 'enfermero_guardia') { 
                        if (!patient.nurseEvolutions) patient.nurseEvolutions = []; 
                        patient.nurseEvolutions.push({ text: note, user: currentUser.fullName, timestamp: Date.now() }); 
                    } else if (currentUser.role === 'medico') { 
                        if (!patient.doctorNotes) patient.doctorNotes = []; 
                        patient.doctorNotes.push({ text: note, doctor: currentUser.fullName, timestamp: Date.now() }); 
                    }
                }
            },
            'start_emergency': () => { isEmergency = true; io.emit('emergency_status_update', isEmergency); },
            'end_emergency': () => { isEmergency = false; io.emit('emergency_status_update', isEmergency); },
        };

        for (const eventName in events) {
            socket.on(eventName, (data) => {
                if (!isAuthenticated) return;
                events[eventName](data);
                saveData();
                io.emit('update_patient_list', patients);
                io.emit('attended_history_update', attendedHistory.sort((a,b) => b.attendedAt - a.attendedAt));
            });
        }
    };
    setupPatientEvents();

    // --- E. Lógica de Historial y Estadísticas ---
    socket.on('get_attended_history', () => {
        if (!isAuthenticated) return;
        socket.emit('attended_history_update', attendedHistory.sort((a,b) => b.attendedAt - a.attendedAt));
    });
    
    socket.on('search_patient_history', ({ query }) => {
        if (!isAuthenticated) return;
        const normalizedQuery = query.toUpperCase().trim();
        const results = attendedHistory.filter(p => (p.dni && p.dni.includes(normalizedQuery)) || p.nombre.toUpperCase().includes(normalizedQuery)).sort((a, b) => b.attendedAt - a.attendedAt);
        socket.emit('patient_history_result', results);
    });

    socket.on('get_stats', () => {
        if (!isAuthenticated || currentUser.role !== 'estadisticas') return;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const patientsToday = attendedHistory.filter(p => p.horaLlegada >= todayStart);
        const stats = {
            totalAttendedToday: patientsToday.length,
            byTriage: patientsToday.reduce((acc, p) => { acc[p.nivelTriage] = (acc[p.nivelTriage] || 0) + 1; return acc; }, {}),
            avgWaitTime: patientsToday.length > 0 ? Math.round(patientsToday.reduce((sum, p) => sum + (p.attendedAt - p.horaLlegada), 0) / patientsToday.length / 60000) : 0,
            byDisposition: patientsToday.reduce((acc, p) => { acc[p.disposition] = (acc[p.disposition] || 0) + 1; return acc; }, {})
        };
        socket.emit('stats_update', stats);
    });

    socket.on('disconnect', () => {
       if(currentUser) console.log(`Usuario desconectado: ${currentUser.user}`);
    });
});


// 6. INICIO DEL SERVIDOR
// =================================================================================
// --- MODIFICACIÓN PARA RENDER ---
const DEPLOY_PORT = process.env.PORT || PORT;

server.listen(DEPLOY_PORT, '0.0.0.0', () => {
    loadData();
    const ip = getLocalIpAddress();
    
    console.log('====================================================');
    console.log('      Sistema Integrado de Guardia INICIADO         ');
    console.log(`      Autor: ${require('./package.json').author}      `);
    console.log('====================================================');
    console.log(`✔️  Servidor escuchando en el puerto ${DEPLOY_PORT}`);
    
    // Si no estamos en Render (producción), mostramos las URLs locales y abrimos el navegador
    if (!process.env.RENDER) {
        console.log(`\n🔗  Accede al portal en tu red local:`);
        console.log(`\x1b[32m%s\x1b[0m`, `     -> http://${ip}:${PORT}`);
        console.log(`\x1b[32m%s\x1b[0m`, `     -> http://localhost:${PORT}`);
        open(`http://localhost:${PORT}`);
    } else {
        console.log('✔️  Ejecutándose en entorno de producción (Render).');
    }
    console.log('====================================================');
});

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}