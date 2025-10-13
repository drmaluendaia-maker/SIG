// =================================================================================
// SERVIDOR DEL SISTEMA INTEGRADO DE GUARDIA (SIG)
// Autor: Dr. Xavier Maluenda y Gemini (Refactorizado por Programador Senior)
// Versión: 5.2 (Arranque Robusto y Corrección de Registro)
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
let db; // La base de datos se inicializará en la función main

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
        // CORRECCIÓN: ID es AUTOINCREMENT para que la DB lo gestione
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
        throw err; // Lanzamos el error para detener el arranque si falla
    }
};

// 4. CONFIGURACIÓN DE EXPRESS Y ESTADO DE LA APLICACIÓN
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));
let activeShifts = {};


// 5. FUNCIONES DE UTILIDAD Y EMISIÓN DE DATOS
// (Funciones broadcastFullState, broadcastAdminData, logAction sin cambios)

// 6. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
    let currentUser = null;
    let isAdminAuthenticated = false;

    const emitAllData = async () => {
        // (sin cambios)
    };
    
    // AUTHENTICATION (sin cambios)

    socket.on('register_patient', async (newPatient) => {
        if (!currentUser || currentUser.role !== 'registro') return;
        try {
            // CORRECCIÓN: No se incluye el 'id' en el INSERT, la DB lo genera
            const { lastID } = await dbRun(
                `INSERT INTO patients (nombre, dni, vitals, notas, nivelTriage, ordenTriage, horaLlegada, status, registeredBy, log, indications)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newPatient.nombre, newPatient.dni, JSON.stringify(newPatient.vitals),
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

    // ... (Resto de listeners de socket sin cambios) ...

    socket.on('disconnect', () => { if (currentUser) console.log(`Usuario desconectado: ${currentUser.user}`); });
});

// 7. FUNCIÓN PRINCIPAL DE ARRANQUE
const main = () => {
    db = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) {
            console.error("❌ Error al abrir la base de datos", err.message);
            process.exit(1);
        }
        console.log("✔️  Conectado a la base de datos SQLite.");
        
        try {
            await initializeDb();
            
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`✔️  Servidor SIG v5.2 escuchando en el puerto ${PORT}`);
                if (!process.env.RENDER) {
                    try {
                        open(`http://localhost:${PORT}`);
                    } catch (e) {
                        console.warn("No se pudo abrir el navegador automáticamente:", e.message);
                    }
                }
            });
        } catch (initErr) {
            console.error("❌  Fallo en la inicialización, el servidor no arrancará.", initErr.message);
            process.exit(1);
        }
    });
};

main(); // Ejecutamos la función principal
