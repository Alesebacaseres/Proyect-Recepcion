// server.js

// Importa los módulos necesarios
const express = require('express');
const cors = require('cors');
const sql = require('mssql'); // Asegúrate de que mssql esté en package.json
// const os = require('os'); // Ya no se usa directamente aquí

// Inicializa la aplicación Express
const app = express();

// Middleware para permitir CORS y parsear JSON
app.use(cors());
app.use(express.json());

// --- Configuración de la Base de Datos ---
const dbServer = process.env.DB_SERVER;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbDatabase = process.env.DB_DATABASE;
const appPort = parseInt(process.env.PORT, 10) || 8080;

// --- Verificación de Variables de Entorno Críticas ---
console.log("--- Verificando variables de entorno ---");
console.log(`DB_SERVER: '${dbServer}'`);
console.log(`DB_USER: '${dbUser}'`);
console.log(`DB_PASSWORD: '${dbPassword ? '******' : 'null'}'`);
console.log(`DB_DATABASE: '${dbDatabase}'`);
console.log(`PORT: '${appPort}'`);
console.log("---------------------------------------");

if (!dbServer || dbServer.trim() === "") { console.error("ERROR: DB_SERVER vacío o no definido."); process.exit(1); }
if (!dbUser || dbUser.trim() === "") { console.error("ERROR: DB_USER vacío o no definido."); process.exit(1); }
if (!dbPassword || dbPassword.trim() === "") { console.error("ERROR: DB_PASSWORD vacío o no definido."); process.exit(1); }
if (!dbDatabase || dbDatabase.trim() === "") { console.error("ERROR: DB_DATABASE vacío o no definido."); process.exit(1); }
if (isNaN(appPort) || appPort <= 0) { console.error("ERROR: PORT inválido."); process.exit(1); }

// --- Configuración para la librería 'mssql' ---
const dbConfig = {
    user: dbUser,
    password: dbPassword,
    server: dbServer,
    database: dbDatabase,
    options: {
        port: 1433,
        encrypt: true,
        trustServerCertificate: true,
    }
};

// --- Lógica de Conexión a la Base de Datos (usando Pool) ---
let pool = null; // Usaremos un pool de conexiones con mssql.
let isDbConnected = false;

async function connectToDatabase() {
    try {
        // Creamos y conectamos un pool de conexiones.
        pool = await new sql.ConnectionPool(dbConfig).connect();
        console.log('Pool de conexión a SQL Server establecido.');
        isDbConnected = true;
        // No es necesario devolver el pool explícitamente si se usa globalmente, pero es buena práctica.
        return pool;
    } catch (err) {
        console.error('ERROR al conectar a la base de datos (pool):', err);
        isDbConnected = false;
        throw err; // Lanzamos el error para que startServer lo capture
    }
}

// --- Función Auxiliar ---
function formatDate(date) {
    if (!date) return "–";
    try {
        if (date instanceof Date && !isNaN(date.getTime())) {
            return date.toLocaleString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } else {
            console.error("Formato de fecha inválido recibido:", date);
            return "Fecha inválida";
        }
    } catch (e) {
        console.error("Error al formatear fecha:", date, e);
        return "Fecha inválida";
    }
}

// --- Rutas de la API ---

// Ruta para obtener el estado general (KPIs)
app.get('/api/status', async (req, res) => {
    if (!pool || !isDbConnected) { // Verificamos que el pool esté listo
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    try {
        // Usamos pool.request() para obtener un objeto request
        const totalPendientesResult = await pool.request().query(`
            SELECT
                (SELECT ISNULL(SUM(Cantidad), 0) FROM PalletsEntrada)
                -
                (SELECT ISNULL(SUM(CantidadDescontada), 0) FROM PalletsDescontados)
                AS TotalPendientesCalculado
        `);
        const totalPendientes = totalPendientesResult.recordset[0]?.TotalPendientesCalculado || 0;

        const totalDescargadosResult = await pool.request().query('SELECT SUM(CantidadDescontada) as TotalDescargados FROM PalletsDescontados');
        const totalDescargados = totalDescargadosResult.recordset[0]?.TotalDescargados || 0;

        const lastIngresoResult = await pool.request().query('SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso FROM PalletsEntrada ORDER BY FechaHoraIngreso DESC');
        const lastDescuentoResult = await pool.request().query('SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento FROM PalletsDescontados PD JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID ORDER BY PD.FechaHoraDescuento DESC');

         let ultimaAccion = "–";
        // Comprobamos si hay resultados y si las fechas son válidas
        if (lastIngresoResult.recordsets && lastIngresoResult.recordsets.length > 0 && lastDescuentoResult.recordsets && lastDescuentoResult.recordsets.length > 0) {
            const ingresoData = lastIngresoResult.recordsets[0][0]; // Acceder a la primera fila del primer resultado
            const descuentoData = lastDescuentoResult.recordsets[0][0];

            const fechaIngreso = new Date(ingresoData.FechaHoraIngreso);
            const fechaDescuento = new Date(descuentoData.FechaHoraDescuento);

            if (!isNaN(fechaIngreso.getTime()) && !isNaN(fechaDescuento.getTime())) {
                if (fechaIngreso > fechaDescuento) {
                    ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad}) a las ${formatDate(fechaIngreso)}`;
                } else {
                    ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente} a las ${formatDate(fechaDescuento)}`;
                }
            } else {
                 ultimaAccion = "Problema al procesar fechas de acción.";
            }
        } else if (lastIngresoResult.recordsets && lastIngresoResult.recordsets.length > 0) {
            const ingresoData = lastIngresoResult.recordsets[0][0];
            ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad}) a las ${formatDate(ingresoData.FechaHoraIngreso)}`;
        } else if (lastDescuentoResult.recordsets && lastDescuentoResult.recordsets.length > 0) {
            const descuentoData = lastDescuentoResult.recordsets[0][0];
            ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente} a las ${formatDate(descuentoData.FechaHoraDescuento)}`;
        }
        
        res.json({
            pendientes: totalPendientes,
            descargados: totalDescargados,
            lastAction: ultimaAccion
        });
    } catch (err) {
        console.error('Error en la ruta /api/status:', err);
        res.status(500).json({ message: 'Error al obtener status', error: err.message });
    }
});

// Ruta para obtener la lista de pallets pendientes
app.get('/api/pendientes', async (req, res) => {
    const searchTerm = req.query.search || '';
    try {
        const query = `
            SELECT
                PE.ID AS PalletEntradaID,
                PE.Cliente,
                PE.Cantidad AS CantidadTotalIngresada,
                ISNULL(SUM(TD.CantidadSolicitada), 0) AS CantidadEnTareas,
                (PE.Cantidad - ISNULL(SUM(TD.CantidadSolicitada), 0)) AS DisponibleParaTareas
            FROM PalletsEntrada PE
            LEFT JOIN TareasDescuento TD ON PE.ID = TD.PalletEntradaID
            WHERE PE.Cliente LIKE @searchTerm
            GROUP BY PE.ID, PE.Cliente, PE.Cantidad
            HAVING (PE.Cantidad - ISNULL(SUM(TD.CantidadSolicitada), 0)) > 0
            ORDER BY PE.ID DESC
        `;
        // Usamos sql.NVarChar para compatibilidad con SQL Server y pasamos el parámetro.
        const params = [{ name: 'searchTerm', type: sql.NVarChar, value: `%${searchTerm}%` }];
        // Usamos pool.request() para obtener un request y luego añadimos el parámetro.
        const result = await pool.request()
            .input('searchTerm', sql.NVarChar, `%${searchTerm}%`)
            .query(query);

        res.json(result.recordsets[0]); // mssql devuelve recordsets[0] para el primer resultado
    } catch (err) {
        console.error('Error al obtener pendientes:', err);
        res.status(500).json({ message: 'Error al obtener pendientes', error: err.message });
    }
});

// Ruta para añadir un nuevo pallet
app.post('/api/pendientes', async (req, res) => {
    console.log('--- Datos recibidos en POST /api/pendientes ---');
    console.log(req.body);
    console.log('----------------------------------------------');

    const { cantidad, cliente, UsuarioIngreso } = req.body;

    // --- VALIDACIONES ---
    if (!cliente || typeof cliente !== 'string' || cliente.trim() === "") { return res.status(400).json({ message: 'Cliente es requerido y debe ser válido.' }); }
    if (!cantidad || typeof cantidad !== 'number' || cantidad <= 0) { return res.status(400).json({ message: 'Cantidad es requerida y debe ser un número positivo.' }); }
    if (!UsuarioIngreso || typeof UsuarioIngreso !== 'string' || UsuarioIngreso.trim() === "") { return res.status(400).json({ message: 'Usuario es requerido y debe ser válido.' }); }

    // --- INSERCIÓN EN LA BASE DE DATOS ---
    const transaction = new sql.Transaction(pool); // Obtenemos la transacción del pool
    try {
        await transaction.begin(); // Iniciamos la transacción

        const request = transaction.request(); // Obtenemos un request de la transacción

        const insertResult = await request
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('UsuarioIngreso', sql.NVarChar, UsuarioIngreso)
            .query(`
                INSERT INTO PalletsEntrada (Cliente, Cantidad, FechaHoraIngreso, UsuarioIngreso)
                VALUES (@cliente, @cantidad, GETDATE(), @UsuarioIngreso);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        await transaction.commit(); // Confirmamos la transacción

        const idInsertado = insertResult.recordset[0].Id;
        res.status(201).json({ message: 'Pallet insertado correctamente', id: idInsertado });

    } catch (error) {
        console.error('Error al insertar pallet:', error);
        if (transaction) await transaction.rollback(); // Deshacemos la transacción si hubo error
        res.status(500).json({ message: 'Error al insertar el pallet en la base de datos.', error: error.message });
    }
});

// Ruta para generar una tarea de descuento
app.post('/api/tareas-descuento', async (req, res) => {
    const { PalletEntradaID, cliente, cantidad, pasillo } = req.body;

    if (!PalletEntradaID || !cliente || !cantidad || !pasillo) {
        return res.status(400).json({ message: 'ID de pallet de entrada, cliente, cantidad y pasillo son requeridas' });
    }

    const transaction = new sql.Transaction(pool); // Obtenemos la transacción del pool
    try {
        await transaction.begin();

        const checkRequest = transaction.request(); // Request dentro de la transacción
        const availableCheckResult = await checkRequest
            .input('PalletEntradaID', sql.Int, PalletEntradaID)
            .query(`
                SELECT PE.Cantidad AS TotalIngresado, ISNULL(SUM(TD.CantidadSolicitada), 0) AS CantidadEnTareas
                FROM PalletsEntrada PE
                LEFT JOIN TareasDescuento TD ON PE.ID = TD.PalletEntradaID
                WHERE PE.ID = @PalletEntradaID
                GROUP BY PE.ID, PE.Cliente, PE.Cantidad
            `);

        if (availableCheckResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Pallet de entrada no encontrado' });
        }

        const disponible = availableCheckResult.recordset[0].TotalIngresado - availableCheckResult.recordset[0].CantidadEnTareas;

        if (cantidad <= 0 || cantidad > disponible) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Disponible: ${disponible}` });
        }

        const insertTaskRequest = transaction.request(); // Request dentro de la transacción
        const insertTaskResult = await insertTaskRequest
            .input('PalletEntradaID', sql.Int, PalletEntradaID)
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidadSolicitada', sql.Int, cantidad)
            .input('pasillo', sql.NVarChar, pasillo)
            .input('usuario', sql.NVarChar, 'Sistema')
            .query(`
                INSERT INTO TareasDescuento (PalletEntradaID, Cliente, CantidadSolicitada, Pasillo, FechaHoraCreacion, UsuarioCreacion, Estado)
                VALUES (@PalletEntradaID, @cliente, @cantidadSolicitada, @pasillo, GETDATE(), @usuario, 'Pendiente');
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const tareaId = insertTaskResult.recordset[0].Id;

        const movimientoRequest = transaction.request(); // Request dentro de la transacción
        await movimientoRequest
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('tareaId', sql.Int, tareaId)
            .input('pasillo', sql.NVarChar, pasillo)
            .input('usuario', sql.NVarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                VALUES ('CREACION_TAREA', @tareaId, @cliente, @cantidad, @pasillo, GETDATE(), @usuario);
            `);

        await transaction.commit();
        res.status(201).json({ message: 'Tarea de descuento generada con éxito', id: tareaId });

    } catch (err) {
        console.error('Error al generar tarea de descuento:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al generar tarea de descuento', error: err.message });
    }
});

// Ruta para obtener las tareas de descuento pendientes
app.get('/api/tareas-descuento', async (req, res) => {
    const searchTerm = req.query.search || '';
    try {
        const query = `
            SELECT
                TD.ID,
                TD.Cliente,
                TD.Pasillo,
                TD.CantidadSolicitada,
                ISNULL(SUM(PD.CantidadDescontada), 0) AS CantidadDescontadaHastaAhora,
                (TD.CantidadSolicitada - ISNULL(SUM(PD.CantidadDescontada), 0)) AS CantidadPendienteDescontar
            FROM TareasDescuento TD
            LEFT JOIN PalletsDescontados PD ON TD.ID = PD.TareaDescuentoID
            WHERE TD.Estado = 'Pendiente'
            GROUP BY TD.ID, TD.Cliente, TD.Pasillo, TD.CantidadSolicitada
            HAVING (TD.CantidadSolicitada - ISNULL(SUM(PD.CantidadDescontada), 0)) > 0
            ORDER BY TD.ID DESC
        `;
        // Los parámetros para esta consulta necesitarán ser definidos según la variable 'searchTerm' si se usa.
        const params = [{ name: 'searchTerm', type: sql.VarChar, value: `%${searchTerm}%` }]; // Usamos sql.VarChar como ejemplo
        const result = await pool.request() // Usamos pool.request()
            .input('searchTerm', sql.VarChar, `%${searchTerm}%`)
            .query(query);

        res.json(result.recordsets[0]);
    } catch (err) {
        console.error('Error al obtener tareas de descuento:', err);
        res.status(500).json({ message: 'Error al obtener tareas de descuento', error: err.message });
    }
});

// Ruta para descontar pallets de una tarea específica
app.post('/api/descontar-pallet', async (req, res) => {
    const { tareaId, cantidadADescontar } = req.body;

    if (!tareaId || !cantidadADescontar) {
        return res.status(400).json({ message: 'ID de tarea y cantidad a descontar son requeridas' });
    }

    const transaction = new sql.Transaction(pool); // Obtenemos la transacción del pool
    try {
        await transaction.begin();

        const tareaResult = await transaction.request() // Usar request de la transacción
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT * FROM TareasDescuento WHERE ID = @tareaId');

        if (tareaResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Tarea no encontrada' });
        }

        const tarea = tareaResult.recordset[0];

        const descontadoTareaResult = await transaction.request() // Usando request de la transacción
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT SUM(CantidadDescontada) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0].TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: ${cantidadPendienteEnTarea}` });
        }

        const insertDescuentoResult = await transaction.request() // Usando request de la transacción
            .input('tareaId', sql.Int, tareaId)
            .input('cliente', sql.NVarChar, tarea.Cliente)
            .input('cantidadDescontada', sql.Int, cantidadADescontar)
            .input('usuario', sql.NVarChar, 'Sistema')
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento)
                VALUES (@tareaId, @cliente, @cantidadDescontada, GETDATE(), @usuario);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const palletDescontadoId = insertDescuentoResult.recordset[0].Id;

        if (cantidadADescontar === cantidadPendienteEnTarea) {
            await transaction.request() // Usando request de la transacción
                .input('tareaId', sql.Int, tareaId)
                .query('UPDATE TareasDescuento SET Estado = \'Completada\' WHERE ID = @tareaId');
        }

        await transaction.request() // Usando request de la transacción para el movimiento
            .input('cliente', sql.NVarChar, tarea.Cliente)
            .input('cantidad', sql.Int, cantidadADescontar)
            .input('tareaId', sql.Int, tareaId)
            .input('palletDescontadoId', sql.Int, palletDescontadoId)
            .input('pasillo', sql.NVarChar, tarea.Pasillo)
            .input('usuario', sql.NVarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, PalletsDescontadosID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                VALUES ('DESCUENTO', @tareaId, @palletDescontadoId, @cliente, @cantidad, @pasillo, GETDATE(), @usuario);
            `);

        await transaction.commit();
        res.json({ message: 'Pallet descontado con éxito', id: palletDescontadoId });

    } catch (err) {
        console.e('Error al descontar pallet:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al descontar pallet', error: err.message });
    }
});

// --- Servir el frontend ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Inicio del servidor ---
async function startServer() {
    try {
        pool = await connectToDatabase(); // Esperamos a que el pool esté conectado

        // --- Creación de tablas si no existen ---
        const createTablesQuery = `
            IF OBJECT_ID('dbo.PalletsEntrada', 'U') IS NULL CREATE TABLE dbo.PalletsEntrada (
                ID INT PRIMARY KEY IDENTITY(1,1), Cliente VARCHAR(50) NOT NULL, Cantidad INT NOT NULL, FechaHoraIngreso DATETIME NOT NULL DEFAULT GETDATE(), UsuarioIngreso VARCHAR(50) NULL
            );

            IF OBJECT_ID('dbo.TareasDescuento', 'U') IS NULL CREATE TABLE dbo.TareasDescuento (
                ID INT PRIMARY KEY IDENTITY(1,1), PalletEntradaID INT NOT NULL, Cliente VARCHAR(50) NOT NULL, CantidadSolicitada INT NOT NULL, Pasillo VARCHAR(50) NOT NULL, FechaHoraCreacion DATETIME NOT NULL DEFAULT GETDATE(), UsuarioCreacion VARCHAR(50) NULL, Estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente', FOREIGN KEY (PalletEntradaID) REFERENCES dbo.PalletsEntrada(ID)
            );

            IF OBJECT_ID('dbo.PalletsDescontados', 'U') IS NULL CREATE TABLE dbo.PalletsDescontados (
                ID INT PRIMARY KEY IDENTITY(1,1), TareaDescuentoID INT NOT NULL, Cliente VARCHAR(50) NOT NULL, CantidadDescontada INT NOT NULL, FechaHoraDescuento DATETIME NOT NULL DEFAULT GETDATE(), UsuarioDescuento VARCHAR(50) NULL, FOREIGN KEY (TareaDescuentoID) REFERENCES dbo.TareasDescuento(ID)
            );

            IF OBJECT_ID('dbo.Movimientos', 'U') IS NULL CREATE TABLE dbo.Movimientos (
                ID INT PRIMARY KEY IDENTITY(1,1), TipoMovimiento VARCHAR(20) NOT NULL, PalletEntradaID INT NULL, TareaDescuentoID INT NULL, PalletsDescontadosID INT NULL, Cliente VARCHAR(50) NOT NULL, Cantidad INT NOT NULL, Pasillo VARCHAR(50) NULL, FechaHora DATETIME NOT NULL DEFAULT GETDATE(), Usuario VARCHAR(50) NULL
            );
        `;
        // Usamos pool.request() para ejecutar la creación de tablas
        await pool.request().query(createTablesQuery);
        console.log("Tablas verificadas/creadas exitosamente.");

        // Inicia el servidor web solo después de que todo esté listo
        app.listen(appPort, () => {
            console.log(`Servidor web escuchando en el puerto ${appPort}`);
        });

    } catch (err) {
        console.error("ERROR FATAL al iniciar el servidor:", err);
        process.exit(1); // Termina la aplicación si hay un error crítico al inicio
    }
}

startServer();