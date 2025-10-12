// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini
// Versión: 3.7.1 (Reparación Crítica de Admin Login)
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

// 2. ESTADO DE LA APLICACIÓN (Sin cambios)
let patients = [], attendedHistory = [], users = [], observationPresets = [], isEmergency = false, currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };
let activeShifts = {};

// 3. PERSISTENCIA DE DATOS (Sin cambios)
const saveData = () => { fs.writeFile(DB_FILE, JSON.stringify({ patients, attendedHistory }, null, 2), err => { if (err) console.error("Error al guardar pacientes:", err); }); };
const saveUsers = () => { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), err => { if (err) console.error("Error al guardar usuarios:", err); }); };
const savePresets = () => { fs.writeFile(PRESETS_FILE, JSON.stringify(observationPresets, null, 2), err => { if (err) console.error("Error al guardar presets:", err); }); };
const loadData = () => { try { if (fs.existsSync(DB_FILE)) { const fileData = fs.readFileSync(DB_FILE); const data = JSON.parse(fileData.length ? fileData : '{}'); patients = data.patients || []; attendedHistory = data.attendedHistory || []; } else { fs.writeFileSync(DB_FILE, JSON.stringify({ patients: [], attendedHistory: [] }, null, 2)); } if (!fs.existsSync(USERS_FILE)) { const defaultUsers = [ { user: "admin", pass: "admin2025", role: "registro", fullName: "Enfermería de Triage", token: "a1" }, { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. Gregory House", token: "b2" }, { user: "enfguardia", pass: "enf123", role: "enfermero_guardia", fullName: "Enfermería de Guardia", token: "c3" }, { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia", token: "d4" } ]; fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2)); } users = JSON.parse(fs.readFileSync(USERS_FILE)); if (!fs.existsSync(PRESETS_FILE)) { const defaultPresets = [ { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico opresivo", level: "naranja" }, { text: "Crisis asmática", level: "amarillo" } ]; fs.writeFileSync(PRESETS_FILE, JSON.stringify(defaultPresets, null, 2)); } observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE)); console.log("✔️  Datos cargados correctamente."); } catch (err) { console.error("❌  Error crítico al cargar datos:", err.message); process.exit(1); }};

// 4. FUNCIONES DE UTILIDAD (Sin cambios)
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
const logAction = (patientId, type, details, user) => { const patient = patients.find(p => p.id === patientId) || attendedHistory.find(p => p.id === patientId); if (patient) { if (!patient.log) patient.log = []; patient.log.push({ id: crypto.randomUUID(), timestamp: Date.now(), type, user: user.fullName, details }); if (activeShifts[user.user]) { activeShifts[user.user].managedPatientIds.add(patientId); } } };

// 5. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;
    let isAuthenticated = false;

    // --- LÓGICA DE EVENTOS PARA USUARIOS AUTENTICADOS ---
    const setupEventListeners = () => {
        socket.on('start_shift', () => { /* ... */ });
        socket.on('end_shift', (callback) => { /* ... */ });
        // (Aquí irían todos los demás eventos de paciente, etc.)
    };

    // --- AUTENTICACIÓN PARA ROLES ESTÁNDAR ---
    const authenticate = (user) => {
        currentUser = user;
        isAuthenticated = true;
        socket.emit('auth_success', user);
        console.log(`Usuario conectado: ${user.user} (${user.role})`);
        socket.emit('presets_update', observationPresets);
        setupEventListeners();
    };
    socket.on('authenticate_user', ({ user, pass }) => { const foundUser = users.find(u => u.user === user && u.pass === pass); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    socket.on('authenticate_token', (token) => { const foundUser = users.find(u => u.token === token); if (foundUser) authenticate(foundUser); else socket.emit('auth_fail'); });
    
    // --- CORRECCIÓN V3.7.1: LÓGICA DE ADMIN RESTAURADA ---
    socket.on('admin_login', ({pass}) => {
        if (pass === ADMIN_MASTER_PASS) {
            currentUser = { role: 'admin', fullName: 'SuperAdmin' };
            isAuthenticated = true; // Activar autenticación para la sesión
            socket.emit('admin_auth_success', {});
            // Activar los listeners de admin para esta conexión
            setupAdminEventListeners(); 
            // Enviar datos iniciales al admin
            socket.emit('users_update', users);
            socket.emit('presets_update', observationPresets);
        } else {
            socket.emit('auth_fail');
        }
    });

    const setupAdminEventListeners = () => {
        const hasAdminPermission = () => isAuthenticated && currentUser && currentUser.role === 'admin';
        socket.on('add_user', (newUser) => { if (hasAdminPermission() && newUser.user && newUser.pass) { if (!users.some(u => u.user === newUser.user)) { newUser.token = crypto.randomBytes(16).toString('hex'); users.push(newUser); saveUsers(); io.emit('users_update', users); } } });
        socket.on('delete_user', (username) => { if (hasAdminPermission() && username) { users = users.filter(u => u.user !== username); saveUsers(); io.emit('users_update', users); } });
        socket.on('edit_user', ({ username, newFullName, newPassword, newRole }) => { if (hasAdminPermission() && username) { const userIndex = users.findIndex(u => u.user === username); if (userIndex > -1) { users[userIndex].fullName = newFullName; users[userIndex].pass = newPassword; users[userIndex].role = newRole; saveUsers(); io.emit('users_update', users); } } });
        socket.on('add_preset', (newPreset) => { if (hasAdminPermission() && newPreset.text && newPreset.level) { if (!observationPresets.some(p => p.text === newPreset.text)) { observationPresets.push(newPreset); savePresets(); io.emit('presets_update', observationPresets); } } });
        socket.on('delete_preset', (presetText) => { if (hasAdminPermission() && presetText) { observationPresets = observationPresets.filter(p => p.text !== presetText); savePresets(); io.emit('presets_update', observationPresets); } });
        socket.on('edit_preset', ({ oldText, newText, newLevel }) => { if (hasAdminPermission()) { const presetIndex = observationPresets.findIndex(p => p.text === oldText); if (presetIndex > -1) { observationPresets[presetIndex] = { text: newText, level: newLevel }; savePresets(); io.emit('presets_update', observationPresets); } } });
    };

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// 6. INICIO DEL SERVIDOR
const DEPLOY_PORT = process.env.PORT || PORT;
server.listen(DEPLOY_PORT, '0.0.0.0', () => {
    loadData();
    console.log(`✔️  Servidor SIG v3.7.1 escuchando en el puerto ${DEPLOY_PORT}`);
    if (!process.env.RENDER) { open(`http://localhost:${PORT}`); }
});
