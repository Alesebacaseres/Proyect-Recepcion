require('dotenv').config(); // Para variables de entorno locales (.env)
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const app = express();

const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT || '1433'),
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

// Función auxiliar para formatear fechas
function formatDate(date) {
    if (!date) return "–";
    try {
        return new Date(date).toLocaleString('es-ES');
    } catch (e) {
        console.error("Error al formatear fecha:", date, e);
        return "Fecha inválida";
    }
}

// --- Rutas de la API ---

// Ruta para obtener el estado general (KPIs)
app.get('/api/status', async (req, res) => {
    try {
        const request = new sql.Request();

        const pendientesCalculado = await request.query(`
            SELECT
                (SELECT ISNULL(SUM(Cantidad), 0) FROM PalletsEntrada)
                -
                (SELECT ISNULL(SUM(CantidadDescontada), 0) FROM PalletsDescontados)
                AS TotalPendientesCalculado
        `);
        const totalPendientes = pendientesCalculado.recordset[0]?.TotalPendientesCalculado || 0;

        const descargadosResult = await request.query('SELECT SUM(CantidadDescontada) as TotalDescargados FROM PalletsDescontados');
        const totalDescargados = descargadosResult.recordset[0]?.TotalDescargados || 0;

        const lastIngreso = await request.query('SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso FROM PalletsEntrada ORDER BY FechaHoraIngreso DESC');
        const lastDescuento = await request.query('SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento FROM PalletsDescontados PD JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID ORDER BY PD.FechaHoraDescuento DESC');

        let ultimaAccion = "–";
        if (lastIngreso.recordset.length > 0 && lastDescuento.recordset.length > 0) {
            if (lastIngreso.recordset[0].FechaHoraIngreso > lastDescuento.recordset[0].FechaHoraDescuento) {
                ultimaAccion = `Ingreso ${lastIngreso.recordset[0].Cliente} (${lastIngreso.recordset[0].Cantidad}) a las ${formatDate(lastIngreso.recordset[0].FechaHoraIngreso)}`;
            } else {
                ultimaAccion = `Descontado ${lastDescuento.recordset[0].CantidadDescontada} de ${lastDescuento.recordset[0].Cliente} a las ${formatDate(lastDescuento.recordset[0].FechaHoraDescuento)}`;
            }
        } else if (lastIngreso.recordset.length > 0) {
            ultimaAccion = `Ingreso ${lastIngreso.recordset[0].Cliente} (${lastIngreso.recordset[0].Cantidad}) a las ${formatDate(lastIngreso.recordset[0].FechaHoraIngreso)}`;
        } else if (lastDescuento.recordset.length > 0) {
            ultimaAccion = `Descontado ${lastDescuento.recordset[0].CantidadDescontada} de ${lastDescuento.recordset[0].Cliente} a las ${formatDate(lastDescuento.recordset[0].FechaHoraDescuento)}`;
        }

        res.json({
            pendientes: totalPendientes,
            descargados: totalDescargados,
            lastAction: ultimaAccion
        });
    } catch (err) {
        console.error('Error al obtener status:', err);
        res.status(500).json({ message: 'Error al obtener status', error: err.message });
    }
});

// Ruta para obtener la lista de pallets pendientes
app.get('/api/pendientes', async (req, res) => {
    const searchTerm = req.query.search || '';
    try {
        const request = new sql.Request();

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
        request.input('searchTerm', sql.VarChar, `%${searchTerm}%`);
        const result = await request.query(query);

        res.json(result.recordset);
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
    let isValid = true;
    let errorMessage = '';

    if (!cliente || typeof cliente !== 'string' || cliente.trim() === "") {
        isValid = false;
        errorMessage = 'Cliente es requerido y debe ser válido.';
    }

    if (!cantidad || typeof cantidad !== 'number' || cantidad <= 0) {
        isValid = false;
        errorMessage = 'Cantidad es requerida y debe ser un número positivo.';
    }

    if (!UsuarioIngreso || typeof UsuarioIngreso !== 'string' || UsuarioIngreso.trim() === "") {
        isValid = false;
        errorMessage = 'Usuario es requerido y debe ser válido.';
    }

    if (!isValid) {
        console.error(`Error de validación en el backend: ${errorMessage}. Datos:`, req.body);
        return res.status(400).json({ message: errorMessage });
    }

    // --- INSERCIÓN EN LA BASE DE DATOS ---
    const transaction = new sql.Transaction();
    try {
        await transaction.begin();
        const reqInsert = transaction.request();

        const insertResult = await reqInsert
            .input('cliente', sql.VarChar, cliente)
            .input('cantidad', sql.Int, cantidad)
            .input('UsuarioIngreso', sql.VarChar, UsuarioIngreso)
            .query(`
                INSERT INTO PalletsEntrada (Cliente, Cantidad, FechaHoraIngreso, UsuarioIngreso)
                VALUES (@cliente, @cantidad, GETDATE(), @UsuarioIngreso);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        await transaction.commit();

        const idInsertado = insertResult.recordset[0].Id;
        res.status(201).json({ message: 'Pallet insertado correctamente', id: idInsertado });

    } catch (error) {
        console.error('Error al insertar pallet:', error);
        await transaction.rollback();
        res.status(500).json({ message: 'Error al insertar el pallet en la base de datos.' });
    }
});
// Ruta para generar una tarea de descuento
app.post('/api/tareas-descuento', async (req, res) => {
    const { PalletEntradaID, cliente, cantidad, pasillo } = req.body;

    if (!PalletEntradaID || !cliente || !cantidad || !pasillo) {
        return res.status(400).json({ message: 'ID de pallet de entrada, cliente, cantidad y pasillo son requeridos' });
    }

   const transaction = new sql.Transaction();
try {
    await transaction.begin();

    // PRIMER QUERY: Chequeo de disponibilidad
    const checkRequest = transaction.request();
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

    // SEGUNDO QUERY: Inserción de tarea
    const insertRequest = transaction.request();
    const insertTaskResult = await insertRequest
        .input('PalletEntradaID', sql.Int, PalletEntradaID)
        .input('cliente', sql.VarChar, cliente)
        .input('cantidadSolicitada', sql.Int, cantidad)
        .input('pasillo', sql.VarChar, pasillo)
        .input('usuario', sql.VarChar, 'Sistema')
        .query(`
            INSERT INTO TareasDescuento (PalletEntradaID, Cliente, CantidadSolicitada, Pasillo, FechaHoraCreacion, UsuarioCreacion, Estado)
            VALUES (@PalletEntradaID, @cliente, @cantidadSolicitada, @pasillo, GETDATE(), @usuario, 'Pendiente');
            SELECT SCOPE_IDENTITY() AS Id;
        `);

    const tareaId = insertTaskResult.recordset[0].Id;

    // TERCER QUERY: Movimiento
    const movimientoRequest = transaction.request();
    await movimientoRequest
        .input('cliente', sql.VarChar, cliente)
        .input('cantidad', sql.Int, cantidad)
        .input('tareaId', sql.Int, tareaId)
        .input('pasillo', sql.VarChar, pasillo)
        .input('usuario', sql.VarChar, 'Sistema')
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
        const request = new sql.Request();

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
        const result = await request.query(query);
        res.json(result.recordset);
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

    const transaction = new sql.Transaction();
    try {
        await transaction.begin();

        // Primer request - obtener tarea
        const tareaResult = await transaction.request()
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT * FROM TareasDescuento WHERE ID = @tareaId');

        if (tareaResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Tarea no encontrada' });
        }

        const tarea = tareaResult.recordset[0];

        // Segundo request - verificar descuento acumulado
        const descontadoTareaResult = await transaction.request()
            .input('tareaId', sql.Int, tareaId)
            .query('SELECT SUM(CantidadDescontada) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0].TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: ${cantidadPendienteEnTarea}` });
        }

        // Tercer request - insertar descuento
        const insertDescuentoResult = await transaction.request()
            .input('tareaId', sql.Int, tareaId)
            .input('cliente', sql.VarChar, tarea.Cliente)
            .input('cantidadDescontada', sql.Int, cantidadADescontar)
            .input('usuario', sql.VarChar, 'Sistema')
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento)
                VALUES (@tareaId, @cliente, @cantidadDescontada, GETDATE(), @usuario);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const palletDescontadoId = insertDescuentoResult.recordset[0].Id;

        // Cuarto request - marcar tarea como completada (si aplica)
        if (cantidadADescontar === cantidadPendienteEnTarea) {
            await transaction.request()
                .input('tareaId', sql.Int, tareaId)
                .query('UPDATE TareasDescuento SET Estado = \'Completada\' WHERE ID = @tareaId');
        }

        // Quinto request - registrar movimiento
        await transaction.request()
            .input('cliente', sql.VarChar, tarea.Cliente)
            .input('cantidad', sql.Int, cantidadADescontar)
            .input('tareaId', sql.Int, tareaId)
            .input('palletDescontadoId', sql.Int, palletDescontadoId)
            .input('pasillo', sql.VarChar, tarea.Pasillo)
            .input('usuario', sql.VarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos
                (TipoMovimiento, TareaDescuentoID, PalletsDescontadosID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
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
// Ruta para borrar todos los datos
app.delete('/api/clear-all', async (req, res) => {
    try {
        const transaction = new sql.Transaction();
        await transaction.begin();

        await transaction.request().query('DELETE FROM Movimientos;');
        await transaction.request().query('DELETE FROM PalletsDescontados;');
        await transaction.request().query('DELETE FROM TareasDescuento;');
        await transaction.request().query('DELETE FROM PalletsEntrada;');

        await transaction.commit();
        res.json({ message: 'Todos los datos han sido borrados.' });
    } catch (err) {
        console.error('Error al borrar datos:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al borrar datos', error: err.message });
    }
});


// --- Servir el frontend ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Inicio del servidor ---
async function startServer() {
    try {
        await sql.connect(dbConfig);
        console.log("Conexión a SQL Server establecida.");

        const createTablesQuery = `
            IF OBJECT_ID('dbo.PalletsEntrada', 'U') IS NULL CREATE TABLE dbo.PalletsEntrada (
                ID INT PRIMARY KEY IDENTITY(1,1),
                Cliente VARCHAR(50) NOT NULL,
                Cantidad INT NOT NULL,
                FechaHoraIngreso DATETIME NOT NULL DEFAULT GETDATE(),
                UsuarioIngreso VARCHAR(50) NULL
            );

            IF OBJECT_ID('dbo.TareasDescuento', 'U') IS NULL CREATE TABLE dbo.TareasDescuento (
                ID INT PRIMARY KEY IDENTITY(1,1),
                PalletEntradaID INT NOT NULL,
                Cliente VARCHAR(50) NOT NULL,
                CantidadSolicitada INT NOT NULL,
                Pasillo VARCHAR(50) NOT NULL,
                FechaHoraCreacion DATETIME NOT NULL DEFAULT GETDATE(),
                UsuarioCreacion VARCHAR(50) NULL,
                Estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
                FOREIGN KEY (PalletEntradaID) REFERENCES dbo.PalletsEntrada(ID)
            );

            IF OBJECT_ID('dbo.PalletsDescontados', 'U') IS NULL CREATE TABLE dbo.PalletsDescontados (
                ID INT PRIMARY KEY IDENTITY(1,1),
                TareaDescuentoID INT NOT NULL,
                Cliente VARCHAR(50) NOT NULL,
                CantidadDescontada INT NOT NULL,
                FechaHoraDescuento DATETIME NOT NULL DEFAULT GETDATE(),
                UsuarioDescuento VARCHAR(50) NULL,
                FOREIGN KEY (TareaDescuentoID) REFERENCES dbo.TareasDescuento(ID)
            );

            IF OBJECT_ID('dbo.Movimientos', 'U') IS NULL CREATE TABLE dbo.Movimientos (
                ID INT PRIMARY KEY IDENTITY(1,1),
                TipoMovimiento VARCHAR(20) NOT NULL,
                PalletEntradaID INT NULL,
                TareaDescuentoID INT NULL,
                PalletsDescontadosID INT NULL,
                Cliente VARCHAR(50) NOT NULL,
                Cantidad INT NOT NULL,
                Pasillo VARCHAR(50) NULL,
                FechaHora DATETIME NOT NULL DEFAULT GETDATE(),
                Usuario VARCHAR(50) NULL
            );
        `;

        const createTablesRequest = new sql.Request();
        await createTablesRequest.query(createTablesQuery);
        console.log("Tablas verificadas/creadas.");

        app.listen(port, () => {
            console.log(`Servidor backend corriendo en http://localhost:${port}`);
        });

    } catch (err) {
        console.error("Error al iniciar el servidor o conectar a la DB:", err);
        process.exit(1);
    }
}

startServer();
