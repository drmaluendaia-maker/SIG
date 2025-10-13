// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini (Refactorizado por Programador Senior)
// Versión: 5.1 (Soporte para SO2 y Corrección de Bugs)
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

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("❌ Error al abrir la base de datos", err.message);
        process.exit(1);
    }
    console.log("✔️  Conectado a la base de datos SQLite.");
    initializeDb();
});

// Helper para ejecutar queries con async/await
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});


// 3. INICIALIZACIÓN DE LA BASE DE DATOS
const initializeDb = async () => {
    try {
        await dbRun(`CREATE TABLE IF NOT EXISTS users (user TEXT PRIMARY KEY, pass TEXT NOT NULL, role TEXT NOT NULL, fullName TEXT NOT NULL, token TEXT NOT NULL)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, dni TEXT, vitals TEXT, notas TEXT, nivelTriage TEXT, ordenTriage INTEGER, horaLlegada INTEGER, status TEXT, registeredBy TEXT, doctor_user TEXT, consultorio INTEGER, attendedAt INTEGER, disposition TEXT, transferData TEXT, log TEXT, indications TEXT)`);
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
            const defaultPresets = [
                { text: "Parada cardiorrespiratoria", level: "rojo" },
                { text: "Dolor torácico opresivo", level: "naranja" },
                { text: "Crisis asmática", level: "amarillo" },
                { text: "Tos y mocos", level: "verde" }
            ];
            for (const p of defaultPresets) {
                await dbRun('INSERT INTO presets (text, level) VALUES (?, ?)', [p.text, p.level]);
            }
        }
        console.log("✔️  Base de datos inicializada correctamente.");
    } catch (err) {
        console.error("❌  Error crítico al inicializar la base de datos:", err.message);
        process.exit(1);
    }
};


// 4. CONFIGURACIÓN DE EXPRESS Y ESTADO DE LA APLICACIÓN
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));

let activeShifts = {};


// 5. FUNCIONES DE UTILIDAD Y EMISIÓN DE DATOS
const broadcastFullState = async () => {
    try {
        const allPatients = await dbAll("SELECT * FROM patients ORDER BY ordenTriage, horaLlegada");
        
        allPatients.forEach(p => {
            p.vitals = JSON.parse(p.vitals || '{}');
            p.log = JSON.parse(p.log || '[]');
            p.indications = JSON.parse(p.indications || '[]');
            p.transferData = JSON.parse(p.transferData || '{}');
        });

        io.emit('update_patient_list', allPatients);
        
        const attendedHistory = allPatients.filter(p => p.status === 'atendido');
        io.emit('attended_history_update', attendedHistory);

    } catch (error) {
        console.error("Error al emitir el estado completo:", error);
    }
};

const broadcastAdminData = async () => {
    try {
        const presets = await dbAll('SELECT text, level FROM presets ORDER BY text');
        io.emit('presets_update', presets);
        const users = await dbAll('SELECT user, role, fullName FROM users');
        io.emit('users_update', users);
    } catch (error) {
        console.error("Error al emitir datos de admin:", error);
    }
};

const logAction = async (patientId, type, details, user) => {
    try {
        const patient = await dbGet('SELECT log FROM patients WHERE id = ?', [patientId]);
        if (patient) {
            const log = JSON.parse(patient.log || '[]');
            log.push({ id: crypto.randomUUID(), timestamp: Date.now(), type, user: user.fullName, details });
            await dbRun('UPDATE patients SET log = ? WHERE id = ?', [JSON.stringify(log), patientId]);

            if (activeShifts[user.user]) {
                activeShifts[user.user].managedPatientIds.add(patientId);
            }
        }
    } catch (error) {
        console.error(`Error al registrar acción para paciente ${patientId}:`, error);
    }
};


// 6. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;
    let isAdminAuthenticated = false;

    const emitAllData = async () => {
        await broadcastFullState();
        await broadcastAdminData();
    };

    socket.on('authenticate_user', async ({ user, pass }) => {
        try {
            const foundUser = await dbGet('SELECT * FROM users WHERE user = ?', [user]);
            if (foundUser && await bcrypt.compare(pass, foundUser.pass)) {
                currentUser = foundUser;
                socket.emit('auth_success', foundUser);
                console.log(`Usuario conectado: ${currentUser.user} (${currentUser.role})`);
                await emitAllData();
            } else {
                socket.emit('auth_fail');
            }
        } catch (error) {
            console.error("Error de autenticación:", error);
            socket.emit('auth_fail');
        }
    });
    
    socket.on('authenticate_token', async (token) => {
        try {
            const foundUser = await dbGet('SELECT * FROM users WHERE token = ?', [token]);
             if (foundUser) {
                currentUser = foundUser;
                socket.emit('auth_success', foundUser);
                console.log(`Usuario conectado por token: ${currentUser.user} (${currentUser.role})`);
                await emitAllData();
            } else {
                socket.emit('auth_fail');
            }
        } catch (error) {
            console.error("Error de autenticación por token:", error);
            socket.emit('auth_fail');
        }
    });

    socket.on('register_patient', async (newPatient) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            const { lastID } = await dbRun(
                `INSERT INTO patients (id, nombre, dni, vitals, notas, nivelTriage, ordenTriage, horaLlegada, status, registeredBy, log, indications)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newPatient.id, newPatient.nombre, newPatient.dni, JSON.stringify(newPatient.vitals),
                    newPatient.notas, newPatient.nivelTriage, newPatient.ordenTriage,
                    newPatient.horaLlegada, 'en_espera', currentUser.user, '[]', '[]'
                ]
            );
            await logAction(lastID, 'Registro', `Motivo: ${newPatient.notas}`, currentUser);
            await broadcastFullState();
        } catch (error) {
            console.error("ERROR CRÍTICO en register_patient:", error);
        }
    });

    socket.on('reevaluate_patient', async (payload) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            const { id, newNotes, newVitals, newLevel } = payload;
            
            const patient = await dbGet('SELECT vitals, notas FROM patients WHERE id = ?', [id]);
            if (!patient) return;

            const currentVitals = JSON.parse(patient.vitals || '{}');
            const updatedVitals = {
                tas: newVitals.tas || currentVitals.tas,
                tad: newVitals.tad || currentVitals.tad,
                fc: newVitals.fc || currentVitals.fc,
                so2: newVitals.so2 || currentVitals.so2,
                temp: newVitals.temp || currentVitals.temp,
                hgt: newVitals.hgt || currentVitals.hgt,
                edad: currentVitals.edad
            };
            
            const triageOrderMap = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };
            const newOrder = triageOrderMap[newLevel];
            const finalNotes = (patient.notas && newNotes) ? `${patient.notas}; ${newNotes}` : (newNotes || patient.notas);

            await dbRun(
                `UPDATE patients SET vitals = ?, notas = ?, nivelTriage = ?, ordenTriage = ? WHERE id = ?`,
                [JSON.stringify(updatedVitals), finalNotes, newLevel, newOrder, id]
            );
            await logAction(id, 'Reevaluación', `Nuevas notas: ${newNotes}. Nivel de Triage actualizado a ${newLevel}.`, currentUser);
            await broadcastFullState();
        } catch (error) {
            console.error("Error en reevaluate_patient:", error);
        }
    });

    // ... (resto de listeners sin cambios)

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// ... (resto del archivo del servidor sin cambios)
