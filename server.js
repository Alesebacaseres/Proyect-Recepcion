// Importa los módulos necesarios
const express = require('express');
const cors = require('cors');
const sql = require('mssql'); // Asegúrate de que mssql esté en package.json
//require('dotenv').config(); // Asegúrate de descomentar si usas .env
const path = require('path');
// *** Importación de csv-stringify ***
const { stringify } = require('csv-stringify');

// Inicializa la aplicación Express
const app = express();

// Middleware para permitir CORS y parsear JSON
app.use(cors());
app.use(express.json());

// --- Configuración de la Base de Datos ---
// Asegúrate de que estas variables de entorno estén configuradas
const dbServer = process.env.DB_SERVER;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbDatabase = process.env.DB_DATABASE;
const appPort = parseInt(process.env.PORT, 10) || 8080;

// --- Verificación de Variables de Entorno Críticas ---
console.log("--- Verificando variables de entorno ---");
console.log(`DB_SERVER: '$'`); // Se dejó como string vacía intencionalmente por el log de ejemplo. Asegúrate de que las variables .env estén bien configuradas.
console.log(`DB_USER: '$'`);
console.log(`DB_PASSWORD: '${dbPassword ? '******' : 'null'}'`);
console.log(`DB_DATABASE: '$'`);
console.log(`PORT: '$'`);
console.log("---------------------------------------");

// Validación más robusta para las variables de entorno
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
        encrypt: true, // Es buena práctica usar encrypt=true si es posible con tu configuración de SQL Server
        trustServerCertificate: true, // Necesario si usas encrypt y el certificado no es de confianza (ej. en desarrollo local)
    }
};

// --- Lógica de Conexión a la Base de Datos (usando Pool) ---
let pool = null; // Usaremos un pool de conexiones con mssql.
let isDbConnected = false;

async function connectToDatabase() {
    try {
        pool = await new sql.ConnectionPool(dbConfig).connect();
        console.log('Pool de conexión a SQL Server establecido.');
        isDbConnected = true;
        return pool;
    } catch (err) {
        console.error('ERROR al conectar a la base de datos (pool):', err);
        isDbConnected = false;
        throw err; // Lanzamos el error para que startServer lo capture
    }
}

// --- Rutas de la API ---

// Ruta para obtener el estado general (KPIs)
app.get('/api/status', async (req, res) => {
    // Si el pool no está listo, devolvemos un error 503 (Service Unavailable)
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para /api/status.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    try {
        const fechaInicioParam = req.query.fechaInicio; // Esperamos formato YYYY-MM-DD

        const request = pool.request(); // Creamos un objeto request

        // Definimos un flag para saber si aplicamos filtro de fecha
        let aplicaFiltroFecha = false;
        if (fechaInicioParam) {
            aplicaFiltroFecha = true;
            // Validar formato de fecha básico. SQL Server lo interpretará, pero es bueno tener algo de validación.
            const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fechaInicioParam);
            if (!fechaValida) {
                return res.status(400).json({ message: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
            }
            request.input('fechaInicio', sql.DateTime, fechaInicioParam);
        }

        // Cálculo de Total Ingresados
        const totalIngresadosResult = await request.query(`
            SELECT ISNULL(SUM(Cantidad), 0) AS TotalIngresado
            FROM PalletsEntrada
            WHERE 1=1 ${aplicaFiltroFecha ? 'AND FechaHoraIngreso >= @fechaInicio AND FechaHoraIngreso < DATEADD(day, 1, @fechaInicio)' : ''}
        `);
        const totalIngresados = totalIngresadosResult.recordset[0]?.TotalIngresado || 0;

        // Cálculo de Total Descontados Directos (donde TareaDescuentoID es NULL)
        const totalDescDirectosResult = await request.query(`
            SELECT ISNULL(SUM(CantidadDescontada), 0) AS TotalDescontadoDirecto
            FROM PalletsDescontados
            WHERE TareaDescuentoID IS NULL ${aplicaFiltroFecha ? 'AND FechaHoraDescuento >= @fechaInicio AND FechaHoraDescuento < DATEADD(day, 1, @fechaInicio)' : ''}
        `);
        const totalDescDirectos = totalDescDirectosResult.recordset[0]?.TotalDescontadoDirecto || 0;

        // Cálculo de Total en Tareas (sumando todas las cantidades solicitadas en todas las tareas, independientemente del estado)
        const totalEnTareasResult = await request.query(`
            SELECT ISNULL(SUM(CantidadSolicitada), 0) AS TotalEnTareas
            FROM TareasDescuento
            WHERE 1=1 ${aplicaFiltroFecha ? 'AND FechaHoraCreacion >= @fechaInicio AND FechaHoraCreacion < DATEADD(day, 1, @fechaInicio)' : ''}
        `);
        const totalEnTareas = totalEnTareasResult.recordset[0]?.TotalEnTareas || 0;

        // Cálculo de Total en Tareas Canceladas (para el KPI "Cancelados")
        const totalTareasCanceladasResult = await request.query(`
            SELECT ISNULL(SUM(CantidadSolicitada), 0) AS TotalEnTareasCanceladas
            FROM TareasDescuento
            WHERE Estado = 'Cancelada' ${aplicaFiltroFecha ? 'AND FechaHoraCreacion >= @fechaInicio AND FechaHoraCreacion < DATEADD(day, 1, @fechaInicio)' : ''}
        `);
        const totalTareasCanceladas = totalTareasCanceladasResult.recordset[0]?.TotalEnTareasCanceladas || 0;

        // Cálculo de Total en Tareas Completadas (para el KPI "Procesados")
        const totalTareasCompletadasResult = await request.query(`
            SELECT ISNULL(SUM(CantidadSolicitada), 0) AS TotalEnTareasCompletadas
            FROM TareasDescuento
            WHERE Estado = 'Completada' ${aplicaFiltroFecha ? 'AND FechaHoraCreacion >= @fechaInicio AND FechaHoraCreacion < DATEADD(day, 1, @fechaInicio)' : ''}
        `);
        const totalTareasCompletadas = totalTareasCompletadasResult.recordset[0]?.TotalEnTareasCompletadas || 0;

        // Definición de los KPIs actualizados
        const pendientesReales = totalIngresados - totalDescDirectos - totalEnTareas;
        const cancelados = totalTareasCanceladas;
        const procesados = totalDescDirectos + totalTareasCompletadas;

        // Cálculo de Última acción (se filtra por fecha si se proporcionó)
        // Usamos un request separado para lastIngreso y lastDescuento para poder usar el filtro de fecha de forma independiente si fuera necesario
        // Aunque en esta implementación ambos usarán el mismo filtro si está presente.

        const lastIngresoRequest = pool.request();
        if (aplicaFiltroFecha) lastIngresoRequest.input('fechaInicio', sql.DateTime, fechaInicioParam);
        const lastIngresoResult = await lastIngresoRequest.query(`
            SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso
            FROM PalletsEntrada
            WHERE 1=1 ${aplicaFiltroFecha ? 'AND FechaHoraIngreso >= @fechaInicio AND FechaHoraIngreso < DATEADD(day, 1, @fechaInicio)' : ''}
            ORDER BY FechaHoraIngreso DESC
        `);

        const lastDescuentoRequest = pool.request();
        if (aplicaFiltroFecha) lastDescuentoRequest.input('fechaInicio', sql.DateTime, fechaInicioParam);
        const lastDescuentoResult = await lastDescuentoRequest.query(`
            SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento
            FROM PalletsDescontados PD
            JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID
            WHERE PD.TareaDescuentoID IS NOT NULL ${aplicaFiltroFecha ? 'AND PD.FechaHoraDescuento >= @fechaInicio AND PD.FechaHoraDescuento < DATEADD(day, 1, @fechaInicio)' : ''}
            ORDER BY PD.FechaHoraDescuento DESC
        `);

        let ultimaAccion = "–";
        let fechaUltimoIngreso = null;
        let fechaUltimoDescuento = null;

        if (lastIngresoResult.recordset && lastIngresoResult.recordset.length > 0) {
            const ingresoData = lastIngresoResult.recordset[0];
            fechaUltimoIngreso = new Date(ingresoData.FechaHoraIngreso);
            // const formattedIngresoDate = fechaUltimoIngreso.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            // La parte del formato de fecha está corregida en el frontend, no la necesitamos aquí para el string.
            ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad})`;
        }

        if (lastDescuentoResult.recordset && lastDescuentoResult.recordset.length > 0) {
            const descuentoData = lastDescuentoResult.recordset[0];
            fechaUltimoDescuento = new Date(descuentoData.FechaHoraDescuento);
            // const formattedDescuentoDate = fechaUltimoDescuento.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // Si el último descuento es más reciente que el último ingreso, o si no hubo ingreso
            if (!fechaUltimoIngreso || (fechaUltimoDescuento > fechaUltimoIngreso)) {
                ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente}`;
            }
        }

        res.json({
            pendientes: pendientesReales,
            cancelados: cancelados,
            descargados: procesados,
            lastAction: ultimaAccion
        });
    } catch (err) {
        console.error('Error en la ruta /api/status:', err);
        res.status(500).json({ message: 'Error al obtener status', error: err.message });
    }
});

// Ruta para obtener la lista de pallets pendientes (con fecha de ingreso)
app.get('/api/pendientes', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para /api/pendientes.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    const searchTerm = req.query.search || ''; // Si no hay search, es un string vacío
    try {
        const query = `
            SELECT
                PE.ID AS PalletEntradaID,
                PE.Cliente,
                PE.Cantidad AS CantidadTotalIngresada,
                PE.FechaHoraIngreso,
                ISNULL(SUM(TD.CantidadSolicitada), 0) AS CantidadEnTareas,
                (PE.Cantidad - ISNULL(SUM(TD.CantidadSolicitada), 0)) AS DisponibleParaTareas

            FROM PalletsEntrada PE
            LEFT JOIN TareasDescuento TD ON PE.ID = TD.PalletEntradaID
            WHERE PE.Cliente LIKE '%' + @searchTerm + '%' -- SQL Server usa '%' para wildcard en LIKE
            GROUP BY PE.ID, PE.Cliente, PE.Cantidad, PE.FechaHoraIngreso
            HAVING (PE.Cantidad - ISNULL(SUM(TD.CantidadSolicitada), 0)) > 0
            ORDER BY PE.ID DESC
        `;
        const result = await pool.request()
            .input('searchTerm', sql.NVarChar, searchTerm) // Pasa el término de búsqueda
            .query(query);

        // Aseguramos que recordset exista y tenga al menos un elemento antes de acceder a [0]
        res.json(result.recordset || []);
    } catch (err) {
        console.error('Error al obtener pendientes:', err);
        res.status(500).json({ message: 'Error al obtener pendientes', error: err.message });
    }
});

// Ruta para añadir un nuevo pallet (registra movimiento de INGRESO)
app.post('/api/pendientes', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para POST /api/pendientes.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    console.log('--- Datos recibidos en POST /api/pendientes ---');
    console.log(req.body);
    console.log('----------------------------------------------');

    const { cantidad, cliente, UsuarioIngreso } = req.body;

    // Validaciones de entrada
    if (!cliente || typeof cliente !== 'string' || cliente.trim() === "") { return res.status(400).json({ message: 'Cliente es requerido y debe ser válido.' }); }
    if (!cantidad || typeof cantidad !== 'number' || cantidad <= 0) { return res.status(400).json({ message: 'Cantidad es requerida y debe ser un número positivo.' }); }
    if (!UsuarioIngreso || typeof UsuarioIngreso !== 'string' || UsuarioIngreso.trim() === "") { return res.status(400).json({ message: 'Usuario es requerido y debe ser válido.' }); }

    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        const request = transaction.request();

        // 1. Insertar en PalletsEntrada
        const insertResult = await request
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('UsuarioIngreso', sql.NVarChar, UsuarioIngreso)
            .query(`
                INSERT INTO PalletsEntrada (Cliente, Cantidad, FechaHoraIngreso, UsuarioIngreso)
                VALUES (@cliente, @cantidad, GETDATE(), @UsuarioIngreso);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        // Verificación importante: Asegurarse de que se obtuvo un ID
        if (!insertResult.recordset || insertResult.recordset.length === 0 || !insertResult.recordset[0].Id) {
            await transaction.rollback();
            throw new Error("No se pudo obtener el ID del pallet recién insertado.");
        }
        const palletEntradaId = insertResult.recordset[0].Id;

        // 2. Registrar movimiento de INGRESO en la tabla Movimientos
        await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('usuario', sql.NVarChar, UsuarioIngreso || 'Sistema') // Usamos el usuario que ingresó el pallet
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, PalletEntradaID, Cliente, Cantidad, FechaHora, Usuario)
                VALUES ('INGRESO', @palletEntradaId, @cliente, @cantidad, GETDATE(), @usuario);
            `);

        await transaction.commit();

        res.status(201).json({ message: 'Pallet insertado correctamente', id: palletEntradaId });

    } catch (error) {
        console.error('Error al insertar pallet o registrar movimiento:', error);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al insertar el pallet en la base de datos.', error: error.message });
    }
});

// Ruta para generar una tarea de descuento
app.post('/api/tareas-descuento', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para POST /api/tareas-descuento.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    const { PalletEntradaID, cliente, cantidad, pasillo, prioridad } = req.body;

    // Validaciones de entrada
    if (!PalletEntradaID || typeof PalletEntradaID !== 'number' || PalletEntradaID <= 0) {
        return res.status(400).json({ message: 'ID de pallet de entrada es requerido y debe ser un número positivo válido.' });
    }
    if (!cliente || typeof cliente !== 'string' || cliente.trim() === "") {
        return res.status(400).json({ message: 'Cliente es requerido y debe ser válido.' });
    }
    if (!cantidad || typeof cantidad !== 'number' || cantidad <= 0) {
        return res.status(400).json({ message: 'Cantidad es requerida y debe ser un número positivo.' });
    }
    if (!pasillo || typeof pasillo !== 'string' || pasillo.trim() === "") {
        return res.status(400).json({ message: 'Pasillo es requerido y debe ser válido.' });
    }
    if (!prioridad || typeof prioridad !== 'string' || prioridad.trim() === "") {
        return res.status(400).json({ message: 'Prioridad es requerida.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        // Verificar disponibilidad de cantidad
        const availableCheckResult = await transaction.request()
            .input('PalletEntradaID', sql.Int, PalletEntradaID)
            .query(`
                SELECT PE.Cantidad AS TotalIngresado, ISNULL(SUM(TD.CantidadSolicitada), 0) AS CantidadEnTareas
                FROM PalletsEntrada PE
                LEFT JOIN TareasDescuento TD ON PE.ID = TD.PalletEntradaID
                WHERE PE.ID = @PalletEntradaID
                GROUP BY PE.ID, PE.Cliente, PE.Cantidad
            `);

        // *** VALIDACIÓN CRÍTICA: Comprobar si se encontraron datos del pallet ***
        if (!availableCheckResult.recordset || availableCheckResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Pallet de entrada no encontrado' });
        }

        const palletInfo = availableCheckResult.recordset[0];
        const disponible = palletInfo.TotalIngresado - palletInfo.CantidadEnTareas;

        if (cantidad <= 0 || cantidad > disponible) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Disponible: $` });
        }

        // 1. Insertar la tarea
        const insertTaskResult = await transaction.request()
            .input('PalletEntradaID', sql.Int, PalletEntradaID)
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidadSolicitada', sql.Int, cantidad)
            .input('pasillo', sql.NVarChar, pasillo)
            .input('usuario', sql.NVarChar, 'Sistema') // Asumo que el usuario se registrará aquí
            .input('prioridad', sql.NVarChar, prioridad) // Prioridad añadida aquí
            .query(`
                INSERT INTO TareasDescuento (PalletEntradaID, Cliente, CantidadSolicitada, Pasillo, FechaHoraCreacion, UsuarioCreacion, Estado, Prioridad, EstadoProceso, UsuarioProcesando)
                VALUES (@PalletEntradaID, @cliente, @cantidadSolicitada, @pasillo, GETDATE(), @usuario, 'Pendiente', @prioridad, 'Libre', NULL);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        // Verificación importante: Asegurarse de que se obtuvo un ID
        if (!insertTaskResult.recordset || insertTaskResult.recordset.length === 0 || !insertTaskResult.recordset[0].Id) {
            await transaction.rollback();
            throw new Error("No se pudo obtener el ID de la tarea recién insertada.");
        }
        const tareaId = insertTaskResult.recordset[0].Id;

        // 2. Registrar movimiento de CREACION_TAREA
        await transaction.request()
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
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para GET /api/tareas-descuento.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    try {
        const query = `
            SELECT
                TD.ID,
                TD.Cliente,
                TD.Pasillo,
                TD.CantidadSolicitada,
                ISNULL(SUM(PD.CantidadDescontada), 0) AS CantidadDescontadaHastaAhora,
                (TD.CantidadSolicitada - ISNULL(SUM(PD.CantidadDescontada), 0)) AS CantidadPendienteDescontar,
                TD.Prioridad,
                -- *** NUEVOS CAMPOS AGREGADOS ***
                TD.EstadoProceso,
                TD.UsuarioProcesando
            FROM TareasDescuento TD
            LEFT JOIN PalletsDescontados PD ON TD.ID = PD.TareaDescuentoID
            WHERE TD.Estado = 'Pendiente'
            GROUP BY TD.ID, TD.Cliente, TD.Pasillo, TD.CantidadSolicitada, TD.Prioridad, TD.EstadoProceso, TD.UsuarioProcesando
            HAVING (TD.CantidadSolicitada - ISNULL(SUM(PD.CantidadDescontada), 0)) > 0
            ORDER BY TD.ID DESC
        `;
        const result = await pool.request()
            .query(query);

        // Aseguramos que recordset exista y tenga al menos un elemento antes de acceder a [0]
        res.json(result.recordset || []);
    } catch (err) {
        console.error('Error al obtener tareas de descuento:', err);
        res.status(500).json({ message: 'Error al obtener tareas de descuento', error: err.message });
    }
});
app.delete('/api/tareas-descuento/:id', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("[ELIMINAR TAREA] ERROR: Pool de base de datos no está listo.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }

    const taskIdFromUrl = req.params.id;
    console.log(`[ELIMINAR TAREA] Solicitud recibida para eliminar tarea ID de URL: '$'`, taskIdFromUrl);

    // --- Validación de ID de Tarea ---
    if (typeof taskIdFromUrl === 'undefined' || taskIdFromUrl === null) {
        console.error("[ELIMINAR TAREA] ERROR FATAL: req.params.id es indefinido o nulo.");
        return res.status(400).json({ message: 'Error interno del servidor: El ID de la tarea no se encuentra en la URL para eliminarla.' });
    }
    const taskId = parseInt(taskIdFromUrl, 10);
    console.log(`[ELIMINAR TAREA] taskId (después de parseInt): $`, taskId);
    if (isNaN(taskId) || taskId <= 0) {
        console.error(`[ELIMINAR TAREA] ERROR FATAL: taskId ($) no es un número válido o es <= 0.`);
        return res.status(400).json({ message: 'Se requiere un ID de tarea numérico válido para eliminarla.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        console.log(`[ELIMINAR TAREA] Iniciando transacción para tarea ID: $`);
        await transaction.begin();
        console.log(`[ELIMINAR TAREA] Transacción iniciada.`);

        // --- 1. Verificar si la tarea existe y no está completada/cancelada (para evitar eliminar tareas ya finalizadas) ---
        console.log(`[ELIMINAR TAREA] Verificando tarea ID: $`);
        const tareaDataResult = await transaction.request()
            .input('taskId', sql.Int, taskId)
            .query('SELECT ID, Estado FROM TareasDescuento WHERE ID = @taskId');

        if (!tareaDataResult.recordset || tareaDataResult.recordset.length === 0) {
            console.error(`[ELIMINAR TAREA] ERROR: Tarea con ID $ no encontrada.`);
            await transaction.rollback();
            console.log(`[ELIMINAR TAREA] Rollback realizado: Tarea no encontrada.`);
            return res.status(404).json({ message: 'Tarea no encontrada.' });
        }
        const tarea = tareaDataResult.recordset[0];

        if (tarea.Estado === 'Completada' || tarea.Estado === 'Cancelada') {
            console.warn(`[ELIMINAR TAREA] ADVERTENCIA: Tarea ID $ ya está en estado '$'. No se elimina.`);
            await transaction.rollback();
            console.log(`[ELIMINAR TAREA] Rollback realizado: Tarea en estado final.`);
            return res.status(400).json({ message: `No se puede eliminar una tarea que ya está '$'.` });
        }

        // --- 2. Eliminar registros relacionados en Movimientos ---
        console.log(`[ELIMINAR TAREA] Eliminando movimientos relacionados para Tarea ID: $`);
        await transaction.request()
            .input('taskId', sql.Int, taskId)
            .query('DELETE FROM Movimientos WHERE TareaDescuentoID = @taskId');
        console.log(`[ELIMINAR TAREA] Movimientos eliminados.`);

        // --- 3. Eliminar registros relacionados en PalletsDescontados ---
        console.log(`[ELIMINAR TAREA] Eliminando entradas en PalletsDescontados para Tarea ID: $`);
        await transaction.request()
            .input('taskId', sql.Int, taskId)
            .query('DELETE FROM PalletsDescontados WHERE TareaDescuentoID = @taskId');
        console.log(`[ELIMINAR TAREA] Entradas en PalletsDescontados eliminadas.`);

        // --- 4. Eliminar la tarea principal ---
        console.log(`[ELIMINAR TAREA] Eliminando tarea principal con ID: $`);
        const deleteResult = await transaction.request()
            .input('taskId', sql.Int, taskId)
            .query('DELETE FROM TareasDescuento WHERE ID = @taskId');

        if (deleteResult.rowsAffected[0] === 0) {
            console.error(`[ELIMINAR TAREA] ERROR FATAL: No se pudo eliminar la tarea principal ID $. Filas afectadas: 0.`);
            await transaction.rollback();
            console.log(`[ELIMINAR TAREA] Rollback realizado: Fallo al eliminar tarea principal.`);
            return res.status(500).json({ message: 'No se pudo eliminar la tarea.' });
        }
        console.log(`[ELIMINAR TAREA] Tarea principal eliminada. Filas afectadas: $`);

        await transaction.commit();
        console.log(`[ELIMINAR TAREA] Transacción commiteada exitosamente. Tarea ID $ eliminada.`);
        res.status(200).json({ message: 'Tarea eliminada correctamente.' });

    } catch (err) {
        console.error(`[ELIMINAR TAREA] ERROR FATAL GENERAL en ruta DELETE para tarea ID: $`, err);
        if (transaction) {
            console.log(`[ELIMINAR TAREA] Haciendo rollback de la transacción para tarea ID: $ debido a un error.`);
            await transaction.rollback();
            console.log(`[ELIMINAR TAREA] Rollback de transacción completado.`);
        }
        res.status(500).json({ message: 'Error al eliminar la tarea.', error: err.message });
    }
});
// Ruta para bloquear/tomar una tarea de descuento
app.post('/api/tareas-descuento/:id/bloquear', async (req, res) => {
    // --- Verificación inicial de la conexión a la base de datos ---
    if (!pool || !isDbConnected) {
        console.log("[BLOQUEAR] ERROR: Pool de base de datos no está listo.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }

    // --- Captura de parámetros y cuerpo de la petición ---
    const taskIdFromUrl = req.params.id; // Lo obtenemos como string de la URL
    const { usuario } = req.body; // Obtiene el nombre del usuario del cuerpo de la petición

    console.log(`[BLOQUEAR] Solicitud recibida para tarea ID de URL: '$'`, taskIdFromUrl); // LOG

    // --- Validación de la entrada: ID de Tarea ---
    if (typeof taskIdFromUrl === 'undefined' || taskIdFromUrl === null) {
        console.error("[BLOQUEAR] ERROR FATAL: req.params.id es indefinido o nulo.");
        return res.status(400).json({ message: 'Error interno del servidor: El ID de la tarea no se encuentra en la URL.' });
    }

    const taskId = parseInt(taskIdFromUrl, 10); // Convertir a número en base 10
    console.log(`[BLOQUEAR] taskId (después de parseInt): $`, taskId); // LOG

    if (isNaN(taskId)) {
        console.error(`[BLOQUEAR] ERROR FATAL: req.params.id ('$') no se pudo parsear a un número válido.`); // LOG ERROR
        return res.status(400).json({ message: 'Se requiere un ID de tarea numérico válido.' });
    }
    if (taskId <= 0) {
        console.error(`[BLOQUEAR] ERROR FATAL: El taskId numérico ($) es menor o igual a cero.`); // LOG ERROR
        return res.status(400).json({ message: 'El ID de la tarea debe ser un número positivo.' });
    }

    // --- Validación de la entrada: Usuario ---
    if (!usuario || typeof usuario !== 'string' || usuario.trim() === "") {
        console.error("[BLOQUEAR] ERROR FATAL: Usuario no es una cadena válida o está indefinido."); // LOG ERROR
        return res.status(400).json({ message: 'El nombre de usuario es requerido para tomar posesión de la tarea.' });
    }

    // --- Inicio de la transacción ---
    const transaction = new sql.Transaction(pool);
    try {
        console.log(`[BLOQUEAR] Iniciando transacción para tarea ID: $`); // LOG
        await transaction.begin();
        console.log(`[BLOQUEAR] Transacción iniciada correctamente.`); // LOG

        // --- 1. Obtener datos actuales de la tarea ---
        console.log(`[BLOQUEAR] Ejecutando SELECT para obtener datos de la tarea ID: $`); // LOG
        const tareaDataResult = await transaction.request()
            .input('taskId', sql.Int, taskId) // Usamos la variable taskId parseada
            .query('SELECT ID, Estado, EstadoProceso, UsuarioProcesando FROM TareasDescuento WHERE ID = @taskId');

        // --- Verificar si la tarea existe ---
        if (!tareaDataResult.recordset || tareaDataResult.recordset.length === 0) {
            console.error(`[BLOQUEAR] ERROR: Tarea con ID $ no encontrada.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[BLOQUEAR] Rollback realizado debido a tarea no encontrada.`); // LOG
            return res.status(404).json({ message: 'Tarea no encontrada.' });
        }
        const tarea = tareaDataResult.recordset[0];
        console.log(`[BLOQUEAR] Datos de la tarea encontrados: EstadoProceso='$', UsuarioProcesando='$'.`); // LOG

        // --- 2. Verificar estado de bloqueo y concurrencia ---
        // Si la tarea ya está en proceso por OTRA persona, devolver un error de conflicto (409)
        if (tarea.EstadoProceso === 'EnProceso' && tarea.UsuarioProcesando !== usuario) {
            console.warn(`[BLOQUEAR] ADVERTENCIA: Tarea ID $ ya en proceso por '$', no se puede tomar por '$'.`); // LOG WARN
            await transaction.rollback();
            console.log(`[BLOQUEAR] Rollback realizado debido a concurrencia de usuario.`); // LOG
            return res.status(409).json({ message: `La tarea ya está siendo procesada por ${tarea.UsuarioProcesando}.` });
        }

        // --- 3. Actualizar estado de la tarea ---
        // Si la tarea está libre o fue bloqueada por el mismo usuario, la tomamos.
        // Actualizamos para marcarla como "EnProceso" y registrar quién la está procesando.
        console.log(`[BLOQUEAR] Ejecutando UPDATE para tarea ID: $ (Estado actual: $, Usuario actual: $) con nuevo usuario: '$'`); // LOG
        const updateResult = await transaction.request()
            .input('taskId', sql.Int, taskId)
            .input('usuario', sql.NVarChar, usuario)
            .query(`
                UPDATE TareasDescuento
                SET EstadoProceso = 'EnProceso', UsuarioProcesando = @usuario, FechaHoraProceso = GETDATE()
                WHERE ID = @taskId AND EstadoProceso IN ('Libre', 'EnProceso') -- Permitimos modificar si está Libre o si el mismo usuario la tiene
            `);

        // --- Verificar si la actualización fue exitosa ---
        if (updateResult.rowsAffected[0] === 0) {
            // Si no se actualizó ninguna fila, significa que el estado cambió o el usuario ya no coincide (por alguna razón)
            console.error(`[BLOQUEAR] ERROR FATAL: No se pudo actualizar la tarea ID $ o el estado/usuario no coincide. Filas afectadas: 0.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[BLOQUEAR] Rollback realizado debido a fallo en la actualización de la tarea.`); // LOG
            // Podría ser que justo fue completada o cancelada por otro proceso, o la concurrencia de usuario falló.
            return res.status(409).json({ message: `No se pudo tomar posesión de la tarea. Puede que ya esté en proceso por otro usuario o en un estado final.` });
        }
        console.log(`[BLOQUEAR] UPDATE de estado de tarea ID $ completado. Filas afectadas: $`); // LOG

        // --- 4. Registrar movimiento si es una nueva toma de posesión ---
        // Solo registramos el movimiento de "TOMA_POSESION" si la tarea estaba anteriormente 'Libre'.
        if (tarea.EstadoProceso === 'Libre') {
            console.log(`[BLOQUEAR] Tarea estaba Libre. Registrando movimiento 'TOMA_POSESION' para tarea ID: $ por usuario '$'`); // LOG
            await transaction.request()
                .input('taskId', sql.Int, taskId)
                .input('usuario', sql.NVarChar, usuario)
                .query(`
                    INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                    SELECT 'TOMA_POSESION', ID, Cliente, CantidadSolicitada, Pasillo, GETDATE(), @usuario
                    FROM TareasDescuento WHERE ID = @taskId
                `);
            console.log(`[BLOQUEAR] Movimiento 'TOMA_POSESION' registrado.`); // LOG
        } else {
            console.log(`[BLOQUEAR] Tarea ID $ ya estaba en proceso por el mismo usuario. No se registra movimiento de toma de posesión adicional.`); // LOG
        }

        // --- 5. Commit de la transacción ---
        console.log(`[BLOQUEAR] Haciendo commit de la transacción para tarea ID: $`); // LOG
        await transaction.commit();
        console.log(`[BLOQUEAR] Transacción commiteada exitosamente.`); // LOG

        // --- Respuesta de éxito ---
        res.json({ message: `Tarea $ tomada con éxito. Ahora puedes proceder a descontar.` });

    } catch (err) {
        // --- Manejo de errores ---
        console.error(`[BLOQUEAR] ERROR FATAL GENERAL en ruta para tarea ID: $`, err); // LOG ERROR GLOBAL

        if (transaction) {
            console.log(`[BLOQUEAR] Haciendo rollback de la transacción para tarea ID: $ debido a un error.`); // LOG ROLLBACK
            await transaction.rollback();
            console.log(`[BLOQUEAR] Rollback de transacción completado.`); // LOG
        }

        // Devolver una respuesta de error al cliente
        res.status(500).json({ message: 'Error al intentar tomar posesión de la tarea.', error: err.message });
    }
});

// Ruta para descontar pallets de una tarea específica
app.post('/api/descontar-pallet', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("[DESCONTAR-PALLET] ERROR: Pool de base de datos no está listo.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }

    // --- Captura de datos del cuerpo de la petición ---
    const { tareaId, cantidadADescontar, usuario } = req.body;

    console.log(`[DESCONTAR-PALLET] Solicitud recibida: TareaID='$', Cantidad='$', Usuario='$'.`); // LOG

    // --- Validación de la entrada ---
    // Validar TareaID
    if (typeof tareaId === 'undefined' || tareaId === null) {
        console.error("[DESCONTAR-PALLET] ERROR FATAL: tareaId es indefinido o nulo en req.body.");
        return res.status(400).json({ message: 'ID de tarea es requerido y debe ser un número positivo.' });
    }
    const taskId = parseInt(tareaId, 10);
    console.log(`[DESCONTAR-PALLET] tareaId parseado: $`, taskId); // LOG
    if (isNaN(taskId) || taskId <= 0) {
        console.error(`[DESCONTAR-PALLET] ERROR FATAL: tareaId ($) no es un número válido o es <= 0.`); // LOG ERROR
        return res.status(400).json({ message: 'ID de tarea es requerido y debe ser un número positivo.' });
    }

    // Validar Cantidad a Descontar
    if (typeof cantidadADescontar === 'undefined' || cantidadADescontar === null) {
        console.error("[DESCONTAR-PALLET] ERROR FATAL: cantidadADescontar es indefinida o nula en req.body.");
        return res.status(400).json({ message: 'Cantidad a descontar es requerida y debe ser un número positivo.' });
    }
    if (typeof cantidadADescontar !== 'number' || cantidadADescontar <= 0) {
        console.error(`[DESCONTAR-PALLET] ERROR FATAL: cantidadADescontar ($) no es un número válido o es <= 0.`); // LOG ERROR
        return res.status(400).json({ message: 'Cantidad a descontar es requerida y debe ser un número positivo.' });
    }

    // Validar Usuario
    if (!usuario || typeof usuario !== 'string' || usuario.trim() === "") {
        console.error("[DESCONTAR-PALLET] ERROR FATAL: Usuario es indefinido o nulo en req.body."); // LOG ERROR
        return res.status(400).json({ message: 'El nombre de usuario es requerido para realizar el descuento.' });
    }

    // --- Inicio de la transacción ---
    const transaction = new sql.Transaction(pool);
    try {
        console.log(`[DESCONTAR-PALLET] Iniciando transacción para TareaID: $`); // LOG
        await transaction.begin();
        console.log(`[DESCONTAR-PALLET] Transacción iniciada.`); // LOG

        // --- 1. Obtener información de la tarea y verificar bloqueo ---
        console.log(`[DESCONTAR-PALLET] Ejecutando SELECT para obtener datos de la tarea ID: $`); // LOG
        const tareaDataResult = await transaction.request()
            .input('tareaId', sql.Int, taskId) // Usamos el taskId parseado
            .query('SELECT ID, Cliente, Pasillo, CantidadSolicitada, EstadoProceso, UsuarioProcesando FROM TareasDescuento WHERE ID = @tareaId');

        if (!tareaDataResult.recordset || tareaDataResult.recordset.length === 0) {
            console.error(`[DESCONTAR-PALLET] ERROR: Tarea con ID $ no encontrada.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[DESCONTAR-PALLET] Rollback realizado: Tarea no encontrada.`); // LOG
            return res.status(404).json({ message: 'Tarea no encontrada.' });
        }
        const tarea = tareaDataResult.recordset[0];
        console.log(`[DESCONTAR-PALLET] Datos de la tarea: Cliente='$', Pasillo='$', CantidadSolicitada=$`); // LOG

        // --- Verificar si la tarea está en proceso por el usuario correcto ---
        if (tarea.EstadoProceso !== 'EnProceso' || tarea.UsuarioProcesando !== usuario) {
            console.warn(`[DESCONTAR-PALLET] ADVERTENCIA: Tarea ID $ no está en proceso o no la tiene el usuario '$'. No se puede descontar.`); // LOG WARN
            await transaction.rollback();
            console.log(`[DESCONTAR-PALLET] Rollback realizado: Permiso de descuento insuficiente.`); // LOG
            if (tarea.EstadoProceso !== 'EnProceso') {
                return res.status(400).json({ message: `La tarea no está actualmente en proceso.` });
            } else {
                return res.status(403).json({ message: `Solo el usuario que inició el proceso ('$') puede descontar de esta tarea.` });
            }
        }

        // --- 2. Calcular cantidad pendiente y verificar si la cantidad a descontar es válida ---
        // Obtener la cantidad ya descontada de esta tarea
        console.log(`[DESCONTAR-PALLET] Calculando cantidad ya descontada para tarea ID: $`); // LOG
        const descontadoTareaResult = await transaction.request()
            .input('tareaId', sql.Int, taskId)
            .query('SELECT ISNULL(SUM(CantidadDescontada), 0) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0]?.TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        console.log(`[DESCONTAR-PALLET] Tarea ID $: Solicitada=$ , Descontado=$ , Pendiente=$`); // LOG
        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            console.error(`[DESCONTAR-PALLET] ERROR FATAL: Cantidad a descontar ($) inválida para Tarea ID $. Pendiente: $.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[DESCONTAR-PALLET] Rollback realizado: Cantidad inválida.`); // LOG
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: $` });
        }

        // --- 3. Registrar el descuento en PalletsDescontados ---
        console.log(`[DESCONTAR-PALLET] Registrando descuento de $ para Tarea ID: $ por usuario '$'`); // LOG
        const insertDescuentoResult = await transaction.request()
            .input('tareaId', sql.Int, taskId)
            .input('cliente', sql.NVarChar, tarea.Cliente)
            .input('cantidadDescontada', sql.Int, cantidadADescontar)
            .input('usuario', sql.NVarChar, usuario)
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento)
                VALUES (@tareaId, @cliente, @cantidadDescontada, GETDATE(), @usuario);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        if (!insertDescuentoResult.recordset || insertDescuentoResult.recordset.length === 0 || !insertDescuentoResult.recordset[0].Id) {
            console.error(`[DESCONTAR-PALLET] ERROR FATAL: No se pudo obtener el ID del descuento registrado para Tarea ID: $`); // LOG ERROR
            await transaction.rollback();
            console.log(`[DESCONTAR-PALLET] Rollback realizado: Fallo al obtener ID de descuento.`); // LOG
            throw new Error("No se pudo obtener el ID del pallet descontado recién insertado.");
        }
        const palletDescontadoId = insertDescuentoResult.recordset[0].Id;
        console.log(`[DESCONTAR-PALLET] Descuento registrado con ID: $`); // LOG

        // --- 4. Actualizar estado de la tarea si se completó ---
        if (cantidadADescontar === cantidadPendienteEnTarea) {
            console.log(`[DESCONTAR-PALLET] Tarea ID $ completada. Actualizando estado a 'Completada'.`); // LOG
            await transaction.request()
                .input('tareaId', sql.Int, taskId)
                .query(`UPDATE TareasDescuento SET Estado = 'Completada', EstadoProceso = 'Libre', UsuarioProcesando = NULL, FechaHoraProceso = NULL WHERE ID = @tareaId`);
        } else {
            // Si no se completó, simplemente liberamos el bloqueo para que otros puedan tomarla.
            // (O podrías dejarla como 'EnProceso' si quieres que solo el mismo usuario pueda seguir descontando,
            // pero liberarla es más seguro para concurrencia general).
            // En este ejemplo, la liberamos.
            console.log(`[DESCONTAR-PALLET] Tarea ID $ parcialmente descontada. Liberando bloqueo.`); // LOG
            await transaction.request()
                .input('tareaId', sql.Int, taskId)
                .query(`UPDATE TareasDescuento SET EstadoProceso = 'Libre', UsuarioProcesando = NULL, FechaHoraProceso = NULL WHERE ID = @tareaId AND EstadoProceso = 'EnProceso'`);
        }

        // --- 5. Registrar movimiento de DESCUENTO ---
        console.log(`[DESCONTAR-PALLET] Registrando movimiento 'DESCUENTO' para Tarea ID: $`); // LOG
        await transaction.request()
            .input('tareaId', sql.Int, taskId)
            .input('palletDescontadoId', sql.Int, palletDescontadoId)
            .input('cliente', sql.NVarChar, tarea.Cliente)
            .input('cantidad', sql.Int, cantidadADescontar)
            .input('pasillo', sql.NVarChar, tarea.Pasillo)
            .input('usuario', sql.NVarChar, usuario)
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, PalletsDescontadosID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                VALUES ('DESCUENTO', @tareaId, @palletDescontadoId, @cliente, @cantidad, @pasillo, GETDATE(), @usuario);
            `);
        console.log(`[DESCONTAR-PALLET] Movimiento 'DESCUENTO' registrado.`); // LOG

        // --- Commit de la transacción ---
        console.log(`[DESCONTAR-PALLET] Haciendo commit de la transacción para Tarea ID: $`); // LOG
        await transaction.commit();
        console.log(`[DESCONTAR-PALLET] Transacción commiteada exitosamente.`); // LOG

        // --- Respuesta de éxito ---
        res.json({ message: 'Pallet descontado con éxito', id: palletDescontadoId });

    } catch (err) {
        // --- Manejo de errores ---
        console.error(`[DESCONTAR-PALLET] ERROR FATAL GENERAL en ruta para Tarea ID: $`, err); // LOG ERROR GLOBAL

        if (transaction) {
            console.log(`[DESCONTAR-PALLET] Haciendo rollback de la transacción para Tarea ID: $ debido a un error.`); // LOG ROLLBACK
            await transaction.rollback();
            console.log(`[DESCONTAR-PALLET] Rollback de transacción completado.`); // LOG
        }

        // Devolver una respuesta de error al cliente
        res.status(500).json({ message: 'Error al descontar pallet', error: err.message });
    }
});

// Ruta para CANCELAR una tarea de descuento (y desbloquearla)
app.post('/api/tareas-descuento/:id/desbloquear', async (req, res) => {
    // --- Verificación inicial de la conexión a la base de datos ---
    if (!pool || !isDbConnected) {
        console.log("[DESBLOQUEAR] ERROR: Pool de base de datos no está listo.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }

    // --- Captura de parámetros y cuerpo de la petición ---
    const taskIdFromUrl = req.params.id; // Lo obtenemos como string de la URL
    const { usuario } = req.body; // Obtiene el nombre del usuario del cuerpo de la petición

    console.log(`[DESBLOQUEAR] Solicitud recibida para tarea ID de URL: '$'`, taskIdFromUrl); // LOG

    // --- Validación de la entrada: ID de Tarea ---
    if (typeof taskIdFromUrl === 'undefined' || taskIdFromUrl === null) {
        console.error("[DESBLOQUEAR] ERROR FATAL: req.params.id es indefinido o nulo.");
        return res.status(400).json({ message: 'Error interno del servidor: El ID de la tarea no se encuentra en la URL para desbloquearla.' });
    }

    const taskId = parseInt(taskIdFromUrl, 10); // Convertir a número en base 10
    console.log(`[DESBLOQUEAR] taskId (después de parseInt): $`, taskId); // LOG

    if (isNaN(taskId)) {
        console.error(`[DESBLOQUEAR] ERROR FATAL: req.params.id ('$') no se pudo parsear a un número válido.`); // LOG ERROR
        return res.status(400).json({ message: 'Se requiere un ID de tarea numérico válido para desbloquearla.' });
    }
    if (taskId <= 0) {
        console.error(`[DESBLOQUEAR] ERROR FATAL: El taskId numérico ($) es menor o igual a cero.`); // LOG ERROR
        return res.status(400).json({ message: 'El ID de la tarea debe ser un número positivo para desbloquearla.' });
    }

    // --- Validación de la entrada: Usuario ---
    if (!usuario || typeof usuario !== 'string' || usuario.trim() === "") {
        console.error("[DESBLOQUEAR] ERROR FATAL: Usuario no es una cadena válida o está indefinido."); // LOG ERROR
        return res.status(400).json({ message: 'El nombre de usuario es requerido para desbloquear la tarea.' });
    }

    // --- Inicio de la transacción ---
    const transaction = new sql.Transaction(pool);
    try {
        console.log(`[DESBLOQUEAR] Iniciando transacción para tarea ID: $`); // LOG
        await transaction.begin();
        console.log(`[DESBLOQUEAR] Transacción iniciada correctamente.`); // LOG

        // --- 1. Obtener datos actuales de la tarea para verificar el bloqueo ---
        console.log(`[DESBLOQUEAR] Ejecutando SELECT para obtener datos de la tarea ID: $`); // LOG
        const tareaDataResult = await transaction.request()
            .input('taskId', sql.Int, taskId) // Usamos la variable taskId parseada
            .query('SELECT ID, Estado, EstadoProceso, UsuarioProcesando FROM TareasDescuento WHERE ID = @taskId');

        // --- Verificar si la tarea existe ---
        if (!tareaDataResult.recordset || tareaDataResult.recordset.length === 0) {
            console.error(`[DESBLOQUEAR] ERROR: Tarea con ID $ no encontrada.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[DESBLOQUEAR] Rollback realizado debido a tarea no encontrada.`); // LOG
            return res.status(404).json({ message: 'Tarea no encontrada.' });
        }
        const tarea = tareaDataResult.recordset[0];
        console.log(`[DESBLOQUEAR] Datos de la tarea encontrados: EstadoProceso='$', UsuarioProcesando='$'.`); // LOG

        // --- 2. Verificar si el usuario tiene permiso para desbloquear ---
        // Solo el usuario que tiene la tarea en proceso puede desbloquearla.
        if (tarea.EstadoProceso !== 'EnProceso' || tarea.UsuarioProcesando !== usuario) {
            console.warn(`[DESBLOQUEAR] ADVERTENCIA: Tarea ID $ no está en proceso o no la tiene el usuario '$'. No se puede desbloquear.`); // LOG WARN
            await transaction.rollback();
            console.log(`[DESBLOQUEAR] Rollback realizado debido a permiso de desbloqueo insuficiente.`); // LOG
            if (tarea.EstadoProceso !== 'EnProceso') {
                return res.status(400).json({ message: `La tarea no está actualmente en proceso.` });
            } else {
                return res.status(403).json({ message: `Solo el usuario que inició el proceso ('$') puede desbloquear esta tarea.` });
            }
        }

        // --- 3. Actualizar estado de la tarea para desbloquearla ---
        console.log(`[DESBLOQUEAR] Ejecutando UPDATE para desbloquear tarea ID: $ de usuario '$'`); // LOG
        const updateResult = await transaction.request()
            .input('taskId', sql.Int, taskId)
            .input('usuario', sql.NVarChar, usuario) // Usar el usuario que validamos
            .query(`
                UPDATE TareasDescuento
                SET EstadoProceso = 'Libre', UsuarioProcesando = NULL, FechaHoraProceso = NULL
                WHERE ID = @taskId AND UsuarioProcesando = @usuario -- Condición para asegurar que el usuario correcto la desbloquea
            `);

        // --- Verificar si la actualización fue exitosa ---
        if (updateResult.rowsAffected[0] === 0) {
            console.error(`[DESBLOQUEAR] ERROR FATAL: No se pudo desbloquear la tarea ID $ para el usuario '$'. Filas afectadas: 0.`); // LOG ERROR
            await transaction.rollback();
            console.log(`[DESBLOQUEAR] Rollback realizado debido a fallo en el desbloqueo.`); // LOG
            // Esto podría ocurrir si la tarea fue completada o cancelada justo antes, o si el usuario no coincidía (aunque ya se validó antes).
            return res.status(409).json({ message: 'No se pudo desbloquear la tarea (posiblemente ya fue finalizada o el usuario no coincide).' });
        }
        console.log(`[DESBLOQUEAR] UPDATE de desbloqueo para tarea ID $ completado. Filas afectadas: $`); // LOG

        // --- 4. Registrar movimiento de DESBLOQUEO_TAREA ---
        console.log(`[DESBLOQUEAR] Registrando movimiento 'DESBLOQUEO_TAREA' para tarea ID: $ por usuario '$'`); // LOG
        await transaction.request()
            .input('taskId', sql.Int, taskId)
            .input('usuario', sql.NVarChar, 'Sistema') // El movimiento lo registra el sistema
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                SELECT 'DESBLOQUEO_TAREA', ID, Cliente, CantidadSolicitada, Pasillo, GETDATE(), @usuario
                FROM TareasDescuento WHERE ID = @taskId
            `);
        console.log(`[DESBLOQUEAR] Movimiento 'DESBLOQUEO_TAREA' registrado.`); // LOG

        // --- 5. Commit de la transacción ---
        console.log(`[DESBLOQUEAR] Haciendo commit de la transacción para tarea ID: $`); // LOG
        await transaction.commit();
        console.log(`[DESBLOQUEAR] Transacción commiteada exitosamente.`); // LOG

        // --- Respuesta de éxito ---
        res.status(200).json({ message: `Tarea $ desbloqueada correctamente.` });

    } catch (err) {
        // --- Manejo de errores ---
        console.error(`[DESBLOQUEAR] ERROR FATAL GENERAL en ruta para tarea ID: $`, err); // LOG ERROR GLOBAL

        if (transaction) {
            console.log(`[DESBLOQUEAR] Haciendo rollback de la transacción para tarea ID: $ debido a un error.`); // LOG ROLLBACK
            await transaction.rollback();
            console.log(`[DESBLOQUEAR] Rollback de transacción completado.`); // LOG
        }

        // Devolver una respuesta de error al cliente
        res.status(500).json({ message: 'Error al desbloquear la tarea.', error: err.message });
    }
});

// Ruta para descontar pallets DIRECTAMENTE (sin una tarea previa)
app.post('/api/descontar-pallet-directo', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para POST /api/descontar-pallet-directo.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    const { palletEntradaId, cantidadADescontar } = req.body;

    // Validaciones de entrada
    if (!palletEntradaId || typeof palletEntradaId !== 'number' || palletEntradaId <= 0) {
        return res.status(400).json({ message: 'ID de pallet de entrada es requerido y debe ser un número positivo.' });
    }
    if (!cantidadADescontar || typeof cantidadADescontar !== 'number' || cantidadADescontar <= 0) {
        return res.status(400).json({ message: 'Cantidad a descontar es requerida y debe ser un número positivo.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        // 1. Obtener detalles del PalletEntrada
        const palletResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query('SELECT ID, Cliente, Cantidad AS TotalIngresado FROM PalletsEntrada WHERE ID = @palletEntradaId');

        // Aseguramos que recordset exista y tenga al menos un elemento antes de acceder a [0]
        if (!palletResult.recordset || palletResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Pallet de entrada no encontrado.' });
        }
        const pallet = palletResult.recordset[0];

        // 2. Calcular cantidad disponible para descuento directo
        const descontadoDirectamenteResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query(`SELECT ISNULL(SUM(CantidadDescontada), 0) AS TotalDescontadoDirecto
                FROM PalletsDescontados WHERE TareaDescuentoID IS NULL AND PalletEntradaID = @palletEntradaId`); // Solo los descuentos DIRECTOS

        const descontadoDirectamente = descontadoDirectamenteResult.recordset[0]?.TotalDescontadoDirecto || 0;

        const cantidadEnTareasResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query(`SELECT ISNULL(SUM(CantidadSolicitada), 0) AS TotalEnTareas FROM TareasDescuento WHERE PalletEntradaID = @palletEntradaId AND Estado = 'Pendiente'`);
        const enTareasPendientes = cantidadEnTareasResult.recordset[0]?.TotalEnTareas || 0;

        const disponibleParaDescuentoDirecto = pallet.TotalIngresado - descontadoDirectamente - enTareasPendientes;

        if (cantidadADescontar <= 0 || cantidadADescontar > disponibleParaDescuentoDirecto) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Disponible para descuento directo: $` });
        }

        // 3. Insertar en PalletsDescontados (marcando que es directo)
        const insertDescuentoResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .input('cliente', sql.NVarChar, pallet.Cliente)
            .input('cantidadDescontada', sql.Int, cantidadADescontar)
            .input('usuario', sql.NVarChar, 'Sistema') // Por defecto 'Sistema' si no se proporciona
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento, PalletEntradaID)
                VALUES (NULL, @cliente, @cantidadDescontada, GETDATE(), @usuario, @palletEntradaId);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        // Verificación importante: Asegurarse de que se obtuvo un ID
        if (!insertDescuentoResult.recordset || insertDescuentoResult.recordset.length === 0 || !insertDescuentoResult.recordset[0].Id) {
            await transaction.rollback();
            throw new Error("No se pudo obtener el ID del pallet descontado directamente recién insertado.");
        }
        const palletDescontadoId = insertDescuentoResult.recordset[0].Id;

        // 4. Registrar movimiento de DESCUENTO_DIRECTO
        await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .input('cliente', sql.NVarChar, pallet.Cliente)
            .input('cantidad', sql.Int, cantidadADescontar)
            .input('palletDescontadoId', sql.Int, palletDescontadoId)
            .input('usuario', sql.NVarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, PalletEntradaID, PalletsDescontadosID, Cliente, Cantidad, FechaHora, Usuario)
                VALUES ('DESCUENTO_DIRECTO', @palletEntradaId, @palletDescontadoId, @cliente, @cantidad, GETDATE(), @usuario);
            `);

        await transaction.commit();
        res.json({ message: 'Pallet descontado directamente con éxito', id: palletDescontadoId });

    } catch (err) {
        console.error('Error al descontar pallet directamente:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al descontar pallet directamente', error: err.message });
    }
});


// --- SERVING THE FRONTEND ---
// Ruta para servir el archivo HTML principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // Asegúrate que index.html esté en la raíz o ajusta la ruta
});

// Ruta para descargar movimientos en formato CSV con filtro de fecha
app.get('/descargar-movimientos', async (req, res) => {
    if (!pool || !isDbConnected) {
        console.log("Pool de base de datos no está listo para descargar movimientos.");
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }

    try {
        const fechaInicioParam = req.query.fechaInicio;
        const fechaFinParam = req.query.fechaFin;

        let queryMovimientos = `
            SELECT
                M.ID AS MovimientoID,
                M.TipoMovimiento,
                CONVERT(varchar, M.FechaHora, 127) AS FechaHoraFormateada,
                M.Cliente,
                M.Cantidad,
                M.Pasillo,
                M.Usuario,
                PE.ID AS PalletEntradaID,
                TD.ID AS TareaDescuentoID,
                PD.ID AS PalletsDescontadosID
            FROM Movimientos M
            LEFT JOIN PalletsEntrada PE ON M.PalletEntradaID = PE.ID
            LEFT JOIN TareasDescuento TD ON M.TareaDescuentoID = TD.ID
            LEFT JOIN PalletsDescontados PD ON M.PalletsDescontadosID = PD.ID
            WHERE 1=1
        `;

        const request = pool.request();

        if (fechaInicioParam) {
            // Validar el formato de fecha
            const fechaValidaInicio = /^\d{4}-\d{2}-\d{2}$/.test(fechaInicioParam);
            if (!fechaValidaInicio) {
                return res.status(400).json({ message: 'Formato de fecha de inicio inválido. Use YYYY-MM-DD.' });
            }
            queryMovimientos += ` AND M.FechaHora >= @fechaInicio`;
            request.input('fechaInicio', sql.DateTime, fechaInicioParam);
        }
        if (fechaFinParam) {
            // Validar el formato de fecha
            const fechaValidaFin = /^\d{4}-\d{2}-\d{2}$/.test(fechaFinParam);
            if (!fechaValidaFin) {
                return res.status(400).json({ message: 'Formato de fecha de fin inválido. Use YYYY-MM-DD.' });
            }
            // Para incluir el día completo, sumamos un día y buscamos menor que eso.
            queryMovimientos += ` AND M.FechaHora < DATEADD(day, 1, @fechaFin)`;
            request.input('fechaFin', sql.DateTime, fechaFinParam);
        }

        queryMovimientos += ` ORDER BY M.FechaHora DESC;`;

        const result = await request.query(queryMovimientos);
        const movimientos = result.recordset; // Usamos .recordset directamente

        if (!movimientos || movimientos.length === 0) {
            console.log("No hay movimientos para descargar en el rango de fechas especificado.");
            return res.status(404).send("No se encontraron movimientos para el rango de fechas seleccionado.");
        }

        const columnasCSV = {
            MovimientoID: "ID Movimiento",
            TipoMovimiento: "Tipo de Movimiento",
            FechaHoraFormateada: "Fecha y Hora",
            Cliente: "Cliente",
            Cantidad: "Cantidad",
            Pasillo: "Pasillo",
            Usuario: "Usuario",
            PalletEntradaID: "Pallet Entrada ID",
            TareaDescuentoID: "Tarea Descuento ID",
            PalletsDescontadosID: "Pallet Descontado ID"
        };

        const options = {
            header: true,
            columns: columnasCSV,
            delimiter: ',',
        };

        stringify(movimientos, options, (err, csvString) => {
            if (err) {
                console.error("Error al generar el archivo CSV:", err);
                return res.status(500).send("Error interno del servidor al generar el archivo.");
            }

            const filename = 'movimientos_registrados.csv';
            res.setHeader('Content-disposition', `attachment; filename="$"`);
            res.setHeader('Content-Type', 'text/csv');

            res.status(200).send(csvString);
            console.log(`Archivo CSV "$" generado y enviado para descarga.`);
        });

    } catch (err) {
        console.error("Error en la ruta /descargar-movimientos:", err);
        res.status(500).json({ message: 'Error al obtener datos para la descarga', error: err.message });
    }
});


// --- Inicio del servidor ---
async function startServer() {
    try {
        await connectToDatabase(); // Esperamos a que el pool esté conectado

        // --- Creación de tablas si no existen ---
        const createTablesQuery = `
            IF OBJECT_ID('dbo.PalletsEntrada', 'U') IS NULL CREATE TABLE dbo.PalletsEntrada (
                ID INT PRIMARY KEY IDENTITY(1,1), Cliente VARCHAR(50) NOT NULL, Cantidad INT NOT NULL, FechaHoraIngreso DATETIME NOT NULL DEFAULT GETDATE(), UsuarioIngreso VARCHAR(50) NULL
            );

            IF OBJECT_ID('dbo.TareasDescuento', 'U') IS NULL CREATE TABLE dbo.TareasDescuento (
                ID INT PRIMARY KEY IDENTITY(1,1), PalletEntradaID INT NOT NULL, Cliente VARCHAR(50) NOT NULL, CantidadSolicitada INT NOT NULL, Pasillo VARCHAR(50) NOT NULL, FechaHoraCreacion DATETIME NOT NULL DEFAULT GETDATE(), UsuarioCreacion VARCHAR(50) NULL, Estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente', Prioridad VARCHAR(50) NULL, EstadoProceso VARCHAR(20) NOT NULL DEFAULT 'Libre', UsuarioProcesando VARCHAR(50) NULL, FechaHoraProceso DATETIME NULL, FOREIGN KEY (PalletEntradaID) REFERENCES dbo.PalletsEntrada(ID)
            );

            IF OBJECT_ID('dbo.PalletsDescontados', 'U') IS NULL CREATE TABLE dbo.PalletsDescontados (
                ID INT PRIMARY KEY IDENTITY(1,1), TareaDescuentoID INT NULL, Cliente VARCHAR(50) NOT NULL, CantidadDescontada INT NOT NULL, FechaHoraDescuento DATETIME NOT NULL DEFAULT GETDATE(), UsuarioDescuento VARCHAR(50) NULL, PalletEntradaID INT NULL, FOREIGN KEY (TareaDescuentoID) REFERENCES dbo.TareasDescuento(ID)
            );

            IF OBJECT_ID('dbo.Movimientos', 'U') IS NULL CREATE TABLE dbo.Movimientos (
                ID INT PRIMARY KEY IDENTITY(1,1), TipoMovimiento VARCHAR(20) NOT NULL, PalletEntradaID INT NULL, TareaDescuentoID INT NULL, PalletsDescontadosID INT NULL, Cliente VARCHAR(50) NOT NULL, Cantidad INT NOT NULL, Pasillo VARCHAR(50) NULL, FechaHora DATETIME NOT NULL DEFAULT GETDATE(), Usuario VARCHAR(50) NULL
            );
        `;
        await pool.request().query(createTablesQuery);
        console.log("Tablas verificadas/creadas exitosamente.");

        // Inicia el servidor web
        app.listen(appPort, () => {
            console.log(`Servidor web escuchando en el puerto $`);
            console.log(`Ruta para descargar movimientos: http://localhost:$/descargar-movimientos`);
        });

    } catch (err) {
        console.error("ERROR FATAL al iniciar el servidor:", err);
        process.exit(1);
    }
}

startServer();
