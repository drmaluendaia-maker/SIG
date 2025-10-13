// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini (Refactorizado por Programador Senior)
// Versión: 5.3 (Nuevas Disposiciones Médicas: Internación y Traslado)
// =================================================================================

// 1. IMPORTACIONES Y CONFIGURACIÓN BÁSICA
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const open = require('open');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;
const ADMIN_MASTER_PASS = "SIGadmin2025";

// 2. CONFIGURACIÓN DE LA BASE DE DATOS
const DATA_DIR = process.env.RENDER_DISK_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'sig.db');
let db;

// Helpers de Base de Datos (sin cambios)
const dbRun = (query, params = []) => new Promise((resolve, reject) => { db.run(query, params, function(err) { if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes }); }); });
const dbGet = (query, params = []) => new Promise((resolve, reject) => { db.get(query, params, (err, row) => { if (err) reject(err); else resolve(row); }); });
const dbAll = (query, params = []) => new Promise((resolve, reject) => { db.all(query, params, (err, rows) => { if (err) reject(err); else resolve(rows); }); });


// 3. INICIALIZACIÓN DE LA BASE DE DATOS
const initializeDb = async () => {
    try {
        await dbRun(`CREATE TABLE IF NOT EXISTS users (user TEXT PRIMARY KEY, pass TEXT NOT NULL, role TEXT NOT NULL, fullName TEXT NOT NULL, token TEXT NOT NULL)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, dni TEXT, vitals TEXT, notas TEXT, nivelTriage TEXT, ordenTriage INTEGER, horaLlegada INTEGER, status TEXT, registeredBy TEXT, doctor_user TEXT, consultorio INTEGER, attendedAt INTEGER, disposition TEXT, transferData TEXT, log TEXT, indications TEXT)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS presets (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL UNIQUE, level TEXT NOT NULL)`);

        const userCount = await dbGet(`SELECT COUNT(*) as count FROM users`);
        if (userCount.count === 0) {
            console.log('Primera ejecución: Creando usuarios por defecto...');
            const defaultUsers = [
                { user: "admin", pass: "admin2025", role: "registro", fullName: "Enfermería de Triage" },
                { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. Gregory House" },
                { user: "enfguardia", pass: "enf123", role: "enfermero_guardia", fullName: "Enfermería de Guardia" },
                { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia" }
            ];
            for (const u of defaultUsers) {
                const hashedPassword = await bcrypt.hash(u.pass, SALT_ROUNDS);
                const token = crypto.randomBytes(16).toString('hex');
                await dbRun('INSERT INTO users (user, pass, role, fullName, token) VALUES (?, ?, ?, ?, ?)', [u.user, hashedPassword, u.role, u.fullName, token]);
            }
            console.log('✔️  Usuarios por defecto creados.');
        }
        const presetCount = await dbGet(`SELECT COUNT(*) as count FROM presets`);
        if (presetCount.count === 0) {
            const defaultPresets = [ { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico opresivo", level: "naranja" }, { text: "Crisis asmática", level: "amarillo" }, { text: "Tos y mocos", level: "verde" }];
            for (const p of defaultPresets) {
                await dbRun('INSERT INTO presets (text, level) VALUES (?, ?)', [p.text, p.level]);
            }
        }
        console.log("✔️  Base de datos inicializada correctamente.");
    } catch (err) {
        console.error("❌  Error crítico al inicializar la base de datos:", err.message);
        throw err;
    }
};

// 4. CONFIGURACIÓN DE EXPRESS Y ESTADO DE LA APLICACIÓN
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));
let activeShifts = {};


// 5. FUNCIONES DE UTILIDAD Y EMISIÓN DE DATOS (sin cambios)
const broadcastFullState = async () => { /* ... */ };
const broadcastAdminData = async () => { /* ... */ };
const logAction = async (patientId, type, details, user) => { /* ... */ };


// 6. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;
    let isAdminAuthenticated = false;

    const emitAllData = async () => { /* ... */ };
    
    // AUTHENTICATION (sin cambios)
    socket.on('authenticate_user', async ({ user, pass }) => { /* ... */ });
    socket.on('authenticate_token', async (token) => { /* ... */ });

    socket.on('register_patient', async (newPatient) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            const { lastID } = await dbRun( `INSERT INTO patients (nombre, dni, vitals, notas, nivelTriage, ordenTriage, horaLlegada, status, registeredBy, log, indications) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ newPatient.nombre, newPatient.dni, JSON.stringify(newPatient.vitals), newPatient.notas, newPatient.nivelTriage, newPatient.ordenTriage, newPatient.horaLlegada, 'en_espera', currentUser.user, '[]', '[]' ]);
            await logAction(lastID, 'Registro', `Motivo: ${newPatient.notas}`, currentUser);
            await broadcastFullState();
        } catch (error) { console.error("ERROR CRÍTICO en register_patient:", error); }
    });

    socket.on('reevaluate_patient', async (payload) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            const { id, newNotes, newVitals, newLevel } = payload;
            const patient = await dbGet('SELECT vitals, notas FROM patients WHERE id = ?', [id]);
            if (!patient) return;

            const currentVitals = JSON.parse(patient.vitals || '{}');
            const updatedVitals = { tas: newVitals.tas || currentVitals.tas, tad: newVitals.tad || currentVitals.tad, fc: newVitals.fc || currentVitals.fc, so2: newVitals.so2 || currentVitals.so2, temp: newVitals.temp || currentVitals.temp, hgt: newVitals.hgt || currentVitals.hgt, edad: currentVitals.edad };
            const triageOrderMap = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };
            const newOrder = triageOrderMap[newLevel];
            const finalNotes = (patient.notas && newNotes) ? `${patient.notas}; ${newNotes}` : (newNotes || patient.notas);

            await dbRun( `UPDATE patients SET vitals = ?, notas = ?, nivelTriage = ?, ordenTriage = ? WHERE id = ?`, [JSON.stringify(updatedVitals), finalNotes, newLevel, newOrder, id]);
            await logAction(id, 'Reevaluación', `Nuevas notas: ${newNotes}. Nivel de Triage actualizado a ${newLevel}.`, currentUser);
            await broadcastFullState();
        } catch (error) { console.error("Error en reevaluate_patient:", error); }
    });

    socket.on('send_to_nursing', async ({ patientId }) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            await dbRun('UPDATE patients SET status = ? WHERE id = ?', ['en_enfermeria', patientId]);
            await logAction(patientId, 'Derivación a Enfermería', 'Paciente enviado directamente a enfermería desde triage.', currentUser);
            await broadcastFullState();
        } catch (error) { console.error("Error en send_to_nursing:", error); }
    });

    socket.on('call_patient', async ({ id, consultorio }) => {
        if (!currentUser || currentUser.role !== 'medico') return;
        try {
            await dbRun('UPDATE patients SET status = ?, consultorio = ?, doctor_user = ? WHERE id = ?', ['atendiendo', consultorio, currentUser.user, id]);
            const patient = await dbGet('SELECT nombre FROM patients WHERE id = ?', [id]);
            const currentlyCalled = { nombre: patient.nombre, consultorio };
            io.emit('update_call', currentlyCalled);
            setTimeout(() => io.emit('update_call', null), 10000);
            await logAction(id, 'Llamado a Consultorio', `Llamado al consultorio ${consultorio}`, currentUser);
            await broadcastFullState();
        } catch (error) { console.error("Error en call_patient:", error); }
    });

    socket.on('update_patient_status', async ({ id, status, disposition }) => {
        if (!currentUser || currentUser.role !== 'medico') return;
        try {
            // Si se está internando, se actualiza también la disposición
            if (disposition === 'Internado') {
                await dbRun('UPDATE patients SET status = ?, disposition = ?, attendedAt = ? WHERE id = ?', [status, disposition, Date.now(), id]);
                await logAction(id, 'Disposición: Internación', `Paciente pasa a estado: ${status}.`, currentUser);
            } else {
                await dbRun('UPDATE patients SET status = ? WHERE id = ?', [status, id]);
                await logAction(id, 'Cambio de Estado', `Paciente pasa a: ${status}.`, currentUser);
            }
            await broadcastFullState();
        } catch (error) { console.error("Error en update_patient_status:", error); }
    });

    socket.on('mark_as_attended', async ({ patientId }) => {
        if (!currentUser || currentUser.role !== 'medico') return;
        try {
            await dbRun('UPDATE patients SET disposition = ?, attendedAt = ? WHERE id = ?', ['Alta', Date.now(), patientId]);
            await logAction(patientId, 'Disposición: Alta Médica', 'Paciente dado de alta.', currentUser);
            await broadcastFullState();
        } catch (error) { console.error("Error en mark_as_attended:", error); }
    });
    
    // NUEVO: Evento para manejar traslados
    socket.on('transfer_patient', async ({ patientId, transferData }) => {
        if (!currentUser || currentUser.role !== 'medico') return;
        try {
            await dbRun('UPDATE patients SET status = ?, disposition = ?, attendedAt = ?, transferData = ? WHERE id = ?', 
                ['atendido', 'Trasladado', Date.now(), JSON.stringify(transferData), patientId]
            );
            const logDetails = `Trasladado a ${transferData.destination}. Médico Receptor: ${transferData.receiver || 'N/A'}. Notas: ${transferData.notes || 'N/A'}`;
            await logAction(patientId, 'Disposición: Traslado', logDetails, currentUser);
            await broadcastFullState();
        } catch (error) {
            console.error("Error en transfer_patient:", error);
        }
    });

    socket.on('add_doctor_note', async ({ id, note }) => { /* ... (sin cambios) */ });
    socket.on('add_nurse_evolution', async ({ id, note }) => { /* ... (sin cambios) */ });
    socket.on('add_indication', async ({ id, text }) => { /* ... (sin cambios) */ });
    socket.on('update_indication_status', async ({ patientId, indicationId }) => { /* ... (sin cambios) */ });
    socket.on('finalize_nursing_task', async ({ patientId }) => { /* ... (sin cambios) */ });
    socket.on('admin_login', ({ pass }) => { /* ... (sin cambios) */ });
    socket.on('add_user', async (newUser) => { /* ... (sin cambios) */ });
    socket.on('edit_user', async (updatedUser) => { /* ... (sin cambios) */ });
    socket.on('delete_user', async (username) => { /* ... (sin cambios) */ });
    socket.on('add_preset', async (newPreset) => { /* ... (sin cambios) */ });
    socket.on('edit_preset', async (payload) => { /* ... (sin cambios) */ });
    socket.on('delete_preset', async (presetText) => { /* ... (sin cambios) */ });
    socket.on('start_shift', () => { /* ... (sin cambios) */ });
    socket.on('end_shift', async (callback) => { /* ... (sin cambios) */ });

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// 7. FUNCIÓN PRINCIPAL DE ARRANQUE
const main = () => {
    db = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) { console.error("❌ Error al abrir la base de datos", err.message); process.exit(1); }
        console.log("✔️  Conectado a la base de datos SQLite.");
        try {
            await initializeDb();
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`✔️  Servidor SIG v5.3 escuchando en el puerto ${PORT}`);
                if (!process.env.RENDER) {
                    try { open(`http://localhost:${PORT}`); } 
                    catch (e) { console.warn("No se pudo abrir el navegador automáticamente:", e.message); }
                }
            });
        } catch (initErr) {
            console.error("❌  Fallo en la inicialización, el servidor no arrancará.", initErr.message);
            process.exit(1);
        }
    });
};

main();
