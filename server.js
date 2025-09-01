// Importa los módulos necesarios
const express = require('express');
const cors = require('cors');
const sql = require('mssql'); // Asegúrate de que mssql esté en package.json
//require('dotenv').config()
const path = require('path')
// *** Importación de csv-stringify ***
const { stringify } = require('csv-stringify');

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
    if (!pool || !isDbConnected) {
        return res.status(503).send('Service Unavailable: Database pool not ready.');
    }
    try {
        // Cálculo de Pendientes: Total Ingresados - Total Descontados
        const totalIngresadosResult = await pool.request().query('SELECT ISNULL(SUM(Cantidad), 0) AS TotalIngresado FROM PalletsEntrada');
        const totalIngresados = totalIngresadosResult.recordset[0]?.TotalIngresado || 0;

        const totalDescargadosResult = await pool.request().query('SELECT ISNULL(SUM(CantidadDescontada), 0) AS TotalDescontado FROM PalletsDescontados');
        const totalDescargados = totalDescargadosResult.recordset[0]?.TotalDescontado || 0; 

        const totalPendientes = totalIngresados - totalDescargados;

        // Última acción de Ingreso
        const lastIngresoResult = await pool.request().query(`
            SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso
            FROM PalletsEntrada
            ORDER BY FechaHoraIngreso DESC
        `);
        // Última acción de Descuento 
        const lastDescuentoResult = await pool.request().query(`
            SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento
            FROM PalletsDescontados PD
            JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID
            ORDER BY PD.FechaHoraDescuento DESC
        `);

        let ultimaAccion = "–";
        let fechaUltimoIngreso = null;
        let fechaUltimoDescuento = null;

        if (lastIngresoResult.recordsets && lastIngresoResult.recordsets.length > 0 && lastIngresoResult.recordsets[0].length > 0) {
            const ingresoData = lastIngresoResult.recordsets[0][0];
            fechaUltimoIngreso = new Date(ingresoData.FechaHoraIngreso);
            const formattedIngresoDate = fechaUltimoIngreso.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad}) a las ${formattedIngresoDate}`;
        }

        if (lastDescuentoResult.recordsets && lastDescuentoResult.recordsets.length > 0 && lastDescuentoResult.recordsets[0].length > 0) {
            const descuentoData = lastDescuentoResult.recordsets[0][0];
            fechaUltimoDescuento = new Date(descuentoData.FechaHoraDescuento);
            const formattedDescuentoDate = fechaUltimoDescuento.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

            if (!fechaUltimoIngreso || (fechaUltimoIngreso && fechaUltimoDescuento > fechaUltimoIngreso)) {
                ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente} a las ${formattedDescuentoDate}`;
            }
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

// Ruta para obtener la lista de pallets pendientes (con fecha de ingreso)
app.get('/api/pendientes', async (req, res) => {
    const searchTerm = req.query.search || '';
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
            WHERE PE.Cliente LIKE @searchTerm
            GROUP BY PE.ID, PE.Cliente, PE.Cantidad, PE.FechaHoraIngreso 
            HAVING (PE.Cantidad - ISNULL(SUM(TD.CantidadSolicitada), 0)) > 0
            ORDER BY PE.ID DESC
        `;
        const result = await pool.request()
            .input('searchTerm', sql.NVarChar, `%${searchTerm}%`)
            .query(query);

        res.json(result.recordsets[0]);
    } catch (err) {
        console.error('Error al obtener pendientes:', err);
        res.status(500).json({ message: 'Error al obtener pendientes', error: err.message });
    }
});

// Ruta para añadir un nuevo pallet (registra movimiento de INGRESO)
app.post('/api/pendientes', async (req, res) => {
    console.log('--- Datos recibidos en POST /api/pendientes ---');
    console.log(req.body);
    console.log('----------------------------------------------');

    const { cantidad, cliente, UsuarioIngreso } = req.body;

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

        const palletEntradaId = insertResult.recordset[0].Id;

        // 2. Registrar movimiento de INGRESO en la tabla Movimientos
        await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .input('cliente', sql.NVarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('usuario', sql.NVarChar, UsuarioIngreso || 'Sistema') 
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
    const { PalletEntradaID, cliente, cantidad, pasillo } = req.body;

    if (!PalletEntradaID || !cliente || !cantidad || !pasillo) {
        return res.status(400).json({ message: 'ID de pallet de entrada, cliente, cantidad y pasillo son requeridas' });
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

        if (availableCheckResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Pallet de entrada no encontrado' });
        }

        const disponible = availableCheckResult.recordset[0].TotalIngresado - availableCheckResult.recordset[0].CantidadEnTareas;

        if (cantidad <= 0 || cantidad > disponible) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Disponible: ${disponible}` });
        }

        // 1. Insertar la tarea
        const insertTaskResult = await transaction.request()
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
        const result = await pool.request()
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

    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        // 1. Obtener detalles de la tarea y la cantidad ya descontada
        const tareaResult = await transaction.request()
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT * FROM TareasDescuento WHERE ID = @tareaId');

        if (tareaResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Tarea no encontrada' });
        }

        const tarea = tareaResult.recordset[0];

        const descontadoTareaResult = await transaction.request()
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT ISNULL(SUM(CantidadDescontada), 0) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0].TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: ${cantidadPendienteEnTarea}` });
        }

        // 2. Insertar en PalletsDescontados
        const insertDescuentoResult = await transaction.request()
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

        // 3. Actualizar estado de TareasDescuento si se completó
        if (cantidadADescontar === cantidadPendienteEnTarea) {
            await transaction.request()
                .input('tareaId', sql.Int, tareaId)
                .query('UPDATE TareasDescuento SET Estado = \'Completada\' WHERE ID = @tareaId');
        }

        // 4. Registrar movimiento de DESCUENTO
        await transaction.request()
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
        console.error('Error al descontar pallet:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al descontar pallet', error: err.message });
    }
});

// Ruta para CANCELAR una tarea de descuento
app.delete('/api/tareas-descuento/:id', async (req, res) => {
    const taskIdToCancel = req.params.id; 

    if (!taskIdToCancel) {
        return res.status(400).json({ message: 'Se requiere el ID de la tarea para cancelarla.' });
    }

    const transaction = new sql.Transaction(pool); 
    try {
        await transaction.begin();

        const updateResult = await transaction.request()
            .input('taskId', sql.Int, taskIdToCancel)
            .query('UPDATE TareasDescuento SET Estado = \'Cancelada\' WHERE ID = @taskId AND Estado = \'Pendiente\'');

        if (updateResult.rowsAffected[0] === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Tarea no encontrada o ya procesada.' });
        }

        await transaction.request()
            .input('taskId', sql.Int, taskIdToCancel)
            .input('usuario', sql.NVarChar, 'Sistema') 
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, Cliente, Cantidad, FechaHora, Usuario)
                VALUES ('CANCELACION_TAREA', @taskId, 'N/A', 0, GETDATE(), @usuario);
            `);

        await transaction.commit();
        res.status(200).json({ message: `Tarea ${taskIdToCancel} cancelada con éxito.` });

    } catch (err) {
        console.error(`Error al cancelar tarea ${taskIdToCancel}:`, err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error interno al procesar la cancelación de la tarea.', error: err.message });
    }
});

// NUEVA RUTA: Ruta para descontar pallets DIRECTAMENTE (sin una tarea previa)
app.post('/api/descontar-pallet-directo', async (req, res) => {
    const { palletEntradaId, cantidadADescontar } = req.body;

    if (!palletEntradaId || !cantidadADescontar) {
        return res.status(400).json({ message: 'ID de pallet de entrada y cantidad a descontar son requeridas.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        // 1. Obtener detalles del PalletEntrada
        const palletResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query('SELECT ID, Cliente, Cantidad AS TotalIngresado FROM PalletsEntrada WHERE ID = @palletEntradaId');

        if (palletResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Pallet de entrada no encontrado.' });
        }

        const pallet = palletResult.recordset[0];

        // 2. Calcular cantidad disponible para descuento directo
        // Sumar descuentos directos de PalletsDescontados (si se guarda PalletEntradaID ahí)
        // O si se usa una columna específica para descuento directo.
        // Asumiendo que PalletsDescontados puede tener PalletEntradaID:
        const descontadoDirectamenteResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query(`SELECT ISNULL(SUM(CantidadDescontada), 0) AS TotalDescontadoDirecto 
                FROM PalletsDescontados WHERE PalletEntradaID = @palletEntradaId`);
        const descontadoDirectamente = descontadoDirectamenteResult.recordset[0]?.TotalDescontadoDirecto || 0;
        
        const cantidadEnTareasResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId)
            .query(`SELECT ISNULL(SUM(CantidadSolicitada), 0) AS TotalEnTareas FROM TareasDescuento WHERE PalletEntradaID = @palletEntradaId AND Estado = 'Pendiente'`);
        const enTareasPendientes = cantidadEnTareasResult.recordset[0]?.TotalEnTareas || 0;

        const disponibleParaDescuentoDirecto = pallet.Cantidad - descontadoDirectamente - enTareasPendientes;

        if (cantidadADescontar <= 0 || cantidadADescontar > disponibleParaDescuentoDirecto) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Disponible para descuento directo: ${disponibleParaDescuentoDirecto}` });
        }

        // 3. Insertar en PalletsDescontados (marcando que es directo)
        const insertDescuentoResult = await transaction.request()
            .input('palletEntradaId', sql.Int, palletEntradaId) 
            .input('cliente', sql.NVarChar, pallet.Cliente)
            .input('cantidadDescontada', sql.Int, cantidadADescontar)
            .input('usuario', sql.NVarChar, 'Sistema') 
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento, PalletEntradaID) 
                VALUES (NULL, @cliente, @cantidadDescontada, GETDATE(), @usuario, @palletEntradaId); 
                SELECT SCOPE_IDENTITY() AS Id;
            `);

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
    res.sendFile(path.join(__dirname, 'index.html')); // ¡AJUSTA ESTA RUTA SI TU INDEX.HTML ESTÁ EN OTRA CARPETA!
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
            queryMovimientos += ` AND M.FechaHora >= @fechaInicio`;
            request.input('fechaInicio', sql.DateTime, fechaInicioParam);
        }
        if (fechaFinParam) {
            queryMovimientos += ` AND M.FechaHora <= @fechaFin`;
            request.input('fechaFin', sql.DateTime, fechaFinParam);
        }

        queryMovimientos += ` ORDER BY M.FechaHora DESC;`;

        const result = await request.query(queryMovimientos);
        const movimientos = result.recordsets[0];

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
            res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'text/csv');

            res.status(200).send(csvString);
            console.log(`Archivo CSV "${filename}" generado y enviado para descarga.`);
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
                ID INT PRIMARY KEY IDENTITY(1,1), PalletEntradaID INT NOT NULL, Cliente VARCHAR(50) NOT NULL, CantidadSolicitada INT NOT NULL, Pasillo VARCHAR(50) NOT NULL, FechaHoraCreacion DATETIME NOT NULL DEFAULT GETDATE(), UsuarioCreacion VARCHAR(50) NULL, Estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente', FOREIGN KEY (PalletEntradaID) REFERENCES dbo.PalletsEntrada(ID)
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
            console.log(`Servidor web escuchando en el puerto ${appPort}`);
            console.log(`Ruta para descargar movimientos: http://localhost:${appPort}/descargar-movimientos`);
        });

    } catch (err) {
        console.error("ERROR FATAL al iniciar el servidor:", err);
        process.exit(1);
    }
}

startServer();