// Importa los módulos necesarios
const express = require('express');
const cors = require('cors'); // Si lo usas para permitir acceso desde el frontend
const tedious = require('tedious'); // Librería para conectar a SQL Server
const os = require('os'); // Para acceder a las variables de entorno

// Inicializa la aplicación Express
const app = express();

// Middleware para permitir CORS y parsear JSON
app.use(cors());
app.use(express.json());

// --- Configuración de la Base de Datos ---
// Lee las variables de entorno PASADAS POR CLOUD RUN.
const dbServer = process.env.DB_SERVER;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbDatabase = process.env.DB_DATABASE;

// Lee el puerto en el que la aplicación debe escuchar.
const appPort = parseInt(process.env.PORT, 10) || 8080;

// --- Verificación de Variables de Entorno Críticas ---
console.log("--- Verificando variables de entorno ---");
console.log(`DB_SERVER: '${process.env.DB_SERVER}'`);
console.log(`DB_USER: '${process.env.DB_USER}'`);
console.log(`DB_PASSWORD: '${process.env.DB_PASSWORD ? '******' : 'null'}'`);
console.log(`DB_DATABASE: '${process.env.DB_DATABASE}'`);
console.log(`PORT: '${process.env.PORT}'`);
console.log("---------------------------------------");

if (!process.env.DB_SERVER || process.env.DB_SERVER.trim() === "") {
    console.error("ERROR: La variable de entorno DB_SERVER está vacía o no definida.");
    process.exit(1);
}
if (!process.env.DB_USER || process.env.DB_USER.trim() === "") {
    console.error("ERROR: La variable de entorno DB_USER está vacía o no definida.");
    process.exit(1);
}
if (!process.env.DB_PASSWORD || process.env.DB_PASSWORD.trim() === "") {
    console.error("ERROR: La variable de entorno DB_PASSWORD está vacía o no definida.");
    process.exit(1);
}
if (!process.env.DB_DATABASE || process.env.DB_DATABASE.trim() === "") {
    console.error("ERROR: La variable de entorno DB_DATABASE está vacía o no definida.");
    process.exit(1);
}
if (isNaN(appPort) || appPort <= 0) {
    console.error("ERROR: El puerto de la aplicación (PORT) no es un número válido.");
    process.exit(1);
}

// --- Configuración para la librería 'tedious' ---
const dbConfig = {
    user: dbUser,
    password: dbPassword,
    server: dbServer,
    options: {
        database: dbDatabase,
        port: 1433, // Puerto estándar de SQL Server. Ajústalo si tu servidor usa otro puerto.
       encrypt: true,
        trustServerCertificate: true,
    }
};

// --- Lógica de Conexión a la Base de Datos ---
let connection = null; // Mantener la conexión global
let isDbConnected = false;

function connectToDatabase() {
    return new Promise((resolve, reject) => {
        try {
            connection = new tedious.Connection(dbConfig);

            connection.on('connect', function(err) {
                if (err) {
                    console.error('ERROR al conectar a la base de datos:', err);
                    isDbConnected = false;
                    reject(err);
                } else {
                    console.log('Conectado a la base de datos.');
                    isDbConnected = true;
                    resolve(connection);
                }
            });

            connection.on('error', function(err) {
                console.error('ERROR general en la conexión de la base de datos:', err);
                isDbConnected = false;
                // Si la conexión se pierde, es crítico para la app, así que salimos.
                process.exit(1);
            });

            connection.connect();
        } catch (err) {
            console.error('ERROR al crear la instancia de conexión:', err);
            isDbConnected = false;
            reject(err);
        }
    });
}

// --- Función Auxiliar ---
function formatDate(date) {
    if (!date) return "–";
    try {
        // Asegúrate de que la fecha es válida antes de intentar formatearla
        if (date instanceof Date && !isNaN(date.getTime())) {
            return date.toLocaleString('es-ES', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } else {
            console.error("Formato de fecha inválido recibido:", date);
            return "Fecha inválida";
        }
    } catch (e) {
        console.error("Error al formatear fecha:", date, e);
        return "Fecha inválida";
    }
}

// --- Función para ejecutar consultas genéricas ---
// Esta función encapsula la creación de un 'Request' y la ejecución de la query.
async function executeQuery(query, params) {
    if (!connection || !isDbConnected) {
        throw new Error("No hay conexión activa a la base de datos.");
    }

    return new Promise((resolve, reject) => {
        // Creamos un nuevo objeto Request para cada consulta.
        const request = new tedious.Request(query, (err, rowCount, rows) => {
            if (err) {
                console.error('ERROR en la ejecución de la consulta:', err);
                reject(err);
            } else {
                // Resolvemos con los resultados de la consulta.
                resolve({ rowCount, rows });
            }
        });

        // Añadimos los parámetros a la consulta.
        if (params) {
            for (const param of params) {
                // Los parámetros deben tener la forma { name: '...', type: tedious.TYPES.DataType, value: ... }
                if (param.name && param.type && param.value !== undefined) {
                    request.addParameter(param.name, param.type, param.value);
                } else {
                    console.warn("Parámetro de consulta inválido:", param);
                }
            }
        }

        // Ejecutamos la consulta.
        connection.execSql(request);
    });
}

// --- Rutas de la API ---

// Ruta para obtener el estado general (KPIs)
app.get('/api/status', async (req, res) => {
    try {
        // Usamos la función 'executeQuery' para hacer las consultas
        const pendientesResult = await executeQuery(`
            SELECT
                (SELECT ISNULL(SUM(Cantidad), 0) FROM PalletsEntrada)
                -
                (SELECT ISNULL(SUM(CantidadDescontada), 0) FROM PalletsDescontados)
                AS TotalPendientesCalculado
        `);
        const totalPendientes = pendientesResult.rows[0]?.TotalPendientesCalculado || 0;

        const descargadosResult = await executeQuery('SELECT SUM(CantidadDescontada) as TotalDescargados FROM PalletsDescontados');
        const totalDescargados = descargadosResult.rows[0]?.TotalDescargados || 0;

        // Para lastIngreso y lastDescuento, necesitarás adaptar las consultas
        // para que devuelvan datos que formatDate pueda manejar correctamente.
        // Asumiendo que FechaHoraIngreso y FechaHoraDescuento son objetos Date o strings válidos.
        const lastIngresoResult = await executeQuery('SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso FROM PalletsEntrada ORDER BY FechaHoraIngreso DESC');
        const lastDescuentoResult = await executeQuery('SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento FROM PalletsDescontados PD JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID ORDER BY PD.FechaHoraDescuento DESC');

        let ultimaAccion = "–";
        if (lastIngresoResult.rows.length > 0 && lastDescuentoResult.rows.length > 0) {
            const ingresoData = lastIngresoResult.rows[0];
            const descuentoData = lastDescuentoResult.rows[0];

            // Aquí es importante que las fechas devueltas por la BD sean manejables por formatDate
            if (new Date(ingresoData.FechaHoraIngreso) > new Date(descuentoData.FechaHoraDescuento)) {
                ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad}) a las ${formatDate(ingresoData.FechaHoraIngreso)}`;
            } else {
                ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente} a las ${formatDate(descuentoData.FechaHoraDescuento)}`;
            }
        } else if (lastIngresoResult.rows.length > 0) {
            const ingresoData = lastIngresoResult.rows[0];
            ultimaAccion = `Ingreso ${ingresoData.Cliente} (${ingresoData.Cantidad}) a las ${formatDate(ingresoData.FechaHoraIngreso)}`;
        } else if (lastDescuentoResult.rows.length > 0) {
            const descuentoData = lastDescuentoResult.rows[0];
            ultimaAccion = `Descontado ${descuentoData.CantidadDescontada} de ${descuentoData.Cliente} a las ${formatDate(descuentoData.FechaHoraDescuento)}`;
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
        // Asegúrate de usar el tipo de dato correcto de 'tedious.TYPES'
        const params = [{ name: 'searchTerm', type: tedious.TYPES.VarChar, value: `%${searchTerm}%` }];
        const result = await executeQuery(query, params); // Usando la función executeQuery

        res.json(result.rows); // Asumiendo que result.rows contiene los datos
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
    // Para operaciones que modifican datos, usar la conexión global 'connection'
    // y obtener un objeto request de ella.
    try {
        const insertRequest = connection.request(); // ¡CORREGIDO! Usando la conexión global

        const insertResult = await insertRequest
            .input('cliente', tedious.TYPES.VarChar, cliente) // Usando tipos de tedious
            .input('cantidad', tedious.TYPES.Int, cantidad)
            .input('UsuarioIngreso', tedious.TYPES.VarChar, UsuarioIngreso)
            .query(`
                INSERT INTO PalletsEntrada (Cliente, Cantidad, FechaHoraIngreso, UsuarioIngreso)
                VALUES (@cliente, @cantidad, GETDATE(), @UsuarioIngreso);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const idInsertado = insertResult.recordset[0].Id;
        res.status(201).json({ message: 'Pallet insertado correctamente', id: idInsertado });

    } catch (error) {
        console.error('Error al insertar pallet:', error);
        // Manejar el error de conexión si es necesario
        res.status(500).json({ message: 'Error al insertar el pallet en la base de datos.' });
    }
});

// Ruta para generar una tarea de descuento
app.post('/api/tareas-descuento', async (req, res) => {
    const { PalletEntradaID, cliente, cantidad, pasillo } = req.body;

    if (!PalletEntradaID || !cliente || !cantidad || !pasillo) {
        return res.status(400).json({ message: 'ID de pallet de entrada, cliente, cantidad y pasillo son requeridos' });
    }

    try {
        // Usar la conexión global y la forma correcta de obtener un request
        const checkRequest = connection.request(); // ¡CORREGIDO!
        const availableCheckResult = await checkRequest
            .input('PalletEntradaID', tedious.TYPES.Int, PalletEntradaID) // Usando tipos de tedious
            .query(`
                SELECT PE.Cantidad AS TotalIngresado, ISNULL(SUM(TD.CantidadSolicitada), 0) AS CantidadEnTareas
                FROM PalletsEntrada PE
                LEFT JOIN TareasDescuento TD ON PE.ID = TD.PalletEntradaID
                WHERE PE.ID = @PalletEntradaID
                GROUP BY PE.ID, PE.Cliente, PE.Cantidad
            `);

        if (availableCheckResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Pallet de entrada no encontrado' });
        }

        const disponible = availableCheckResult.recordset[0].TotalIngresado - availableCheckResult.recordset[0].CantidadEnTareas;

        if (cantidad <= 0 || cantidad > disponible) {
            return res.status(400).json({ message: `Cantidad inválida. Disponible: ${disponible}` });
        }

        const insertTaskRequest = connection.request(); // ¡CORREGIDO!
        const insertTaskResult = await insertTaskRequest
            .input('PalletEntradaID', tedious.TYPES.Int, PalletEntradaID)
            .input('cliente', tedious.TYPES.VarChar, cliente)
            .input('cantidadSolicitada', tedious.TYPES.Int, cantidad)
            .input('pasillo', tedious.TYPES.VarChar, pasillo)
            .input('usuario', tedious.TYPES.VarChar, 'Sistema')
            .query(`
                INSERT INTO TareasDescuento (PalletEntradaID, Cliente, CantidadSolicitada, Pasillo, FechaHoraCreacion, UsuarioCreacion, Estado)
                VALUES (@PalletEntradaID, @cliente, @cantidadSolicitada, @pasillo, GETDATE(), @usuario, 'Pendiente');
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const tareaId = insertTaskResult.recordset[0].Id;

        const movimientoRequest = connection.request(); // ¡CORREGIDO!
        await movimientoRequest
            .input('cliente', tedious.TYPES.VarChar, tarea.Cliente)
            .input('cantidad', tedious.TYPES.Int, cantidad)
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .input('pasillo', tedious.TYPES.VarChar, pasillo)
            .input('usuario', tedious.TYPES.VarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                VALUES ('CREACION_TAREA', @tareaId, @cliente, @cantidad, @pasillo, GETDATE(), @usuario);
            `);

        res.status(201).json({ message: 'Tarea de descuento generada con éxito', id: tareaId });

    } catch (err) {
        console.error('Error al generar tarea de descuento:', err);
        res.status(500).json({ message: 'Error al generar tarea de descuento', error: err.message });
    }
});

// Ruta para obtener las tareas de descuento pendientes
app.get('/api/tareas-descuento', async (req, res) => {
    const searchTerm = req.query.search || '';
    try {
        const request = connection.request(); // ¡CORREGIDO!

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
        const params = [{ name: 'searchTerm', type: tedious.TYPES.VarChar, value: `%${searchTerm}%` }];
        const result = await executeQuery(query, params); // Usando la función executeQuery

        res.json(result.rows);
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

    try {
        // Usar la conexión global y la forma correcta de obtener un request.
        // Asegúrate de que las operaciones de base de datos estén dentro de una transacción si es necesario.

        // Primer request - obtener tarea
        const tareaResult = await connection.request() // ¡CORREGIDO!
            .input('tareaId', tedious.TYPES.Int, tareaId) // Usando tipos de tedious
            .query('SELECT * FROM TareasDescuento WHERE ID = @tareaId');

        if (tareaResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Tarea no encontrada' });
        }

        const tarea = tareaResult.recordset[0];

        // Segundo request - verificar descuento acumulado
        const descontadoTareaResult = await connection.request() // ¡CORREGIDO!
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .query('SELECT SUM(CantidadDescontada) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0].TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: ${cantidadPendienteEnTarea}` });
        }

        // Tercer request - insertar descuento
        const insertDescuentoResult = await connection.request() // ¡CORREGIDO!
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .input('cliente', tedious.TYPES.VarChar, tarea.Cliente)
            .input('cantidadDescontada', tedious.TYPES.Int, cantidadADescontar)
            .input('usuario', tedious.TYPES.VarChar, 'Sistema')
            .query(`
                INSERT INTO PalletsDescontados (TareaDescuentoID, Cliente, CantidadDescontada, FechaHoraDescuento, UsuarioDescuento)
                VALUES (@tareaId, @cliente, @cantidadDescontada, GETDATE(), @usuario);
                SELECT SCOPE_IDENTITY() AS Id;
            `);

        const palletDescontadoId = insertDescuentoResult.recordset[0].Id;

        // Cuarto request - marcar tarea como completada (si aplica)
        if (cantidadADescontar === cantidadPendienteEnTarea) {
            await connection.request() // ¡CORREGIDO!
                .input('tareaId', tedious.TYPES.Int, tareaId)
                .query('UPDATE TareasDescuento SET Estado = \'Completada\' WHERE ID = @tareaId');
        }

        // Quinto request - registrar movimiento
        await connection.request() // ¡CORREGIDO!
            .input('cliente', tedious.TYPES.VarChar, tarea.Cliente)
            .input('cantidad', tedious.TYPES.Int, cantidadADescontar)
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .input('palletDescontadoId', tedious.TYPES.Int, palletDescontadoId)
            .input('pasillo', tedious.TYPES.VarChar, tarea.Pasillo)
            .input('usuario', tedious.TYPES.VarChar, 'Sistema')
            .query(`
                INSERT INTO Movimientos (TipoMovimiento, TareaDescuentoID, PalletsDescontadosID, Cliente, Cantidad, Pasillo, FechaHora, Usuario)
                VALUES ('DESCUENTO', @tareaId, @palletDescontadoId, @cliente, @cantidad, @pasillo, GETDATE(), @usuario);
            `);

        res.json({ message: 'Pallet descontado con éxito', id: palletDescontadoId });

    } catch (err) {
        console.error('Error al descontar pallet:', err);
        res.status(500).json({ message: 'Error al descontar pallet', error: err.message });
    }
});

// Ruta para borrar todos los datos
app.delete('/api/clear-all', async (req, res) => {
    try {
        // Para borrar, necesitas una conexión activa.
        if (!connection || !isDbConnected) {
            return res.status(503).json({ message: 'Database not connected, cannot clear data.' });
        }

        // Aquí necesitas usar la forma correcta de manejar transacciones con tedious.
        // Puede ser que la 'connection' object tenga un método para iniciar transacción.
        // Si no, tendrías que verificar la documentación de tedious para esto.
        // Asumiendo que connection.transaction() devuelve un objeto transaccion:
        const transaction = connection.transaction(); // ¡CORREGIDO! Asumiendo que es así
        await transaction.begin();

        await transaction.request().query('DELETE FROM Movimientos;');
        await transaction.request().query('DELETE FROM PalletsDescontados;');
        await transaction.request().query('DELETE FROM TareasDescuento;');
        await transaction.request().query('DELETE FROM PalletsEntrada;');

        await transaction.commit();
        res.json({ message: 'Todos los datos han sido borrados.' });
    } catch (err) {
        console.error('Error al borrar datos:', err);
        if (connection && connection.rollback) { // Si connection tiene rollback
            await connection.rollback();
        } else if (transaction && transaction.rollback) { // O si el objeto transaction tiene rollback
            await transaction.rollback();
        }
        res.status(500).json({ message: 'Error al borrar datos', error: err.message });
    }
});

// --- Servir el frontend ---
// Esta ruta debe ir DESPUÉS de las rutas de la API.
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Inicio del servidor ---
async function startServer() {
    try {
        // Conexión a la base de datos
        await connectToDatabase();

        // --- Creación de tablas si no existen ---
        // Esto es útil para desarrollo, pero en producción usualmente las tablas ya están creadas.
        // Si el deploy fails porque las tablas no existen, esto debería crearlas.
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

        // Ejecuta la creación de tablas usando la conexión
        const createTablesRequest = connection.request(); // ¡CORREGIDO!
        await createTablesRequest.query(createTablesQuery);
        console.log("Tablas verificadas/creadas.");

        // Inicia el servidor web solo después de que la conexión y las tablas estén listas.
        app.listen(appPort, () => {
            console.log(`Servidor web escuchando en el puerto ${appPort}`);
        });

    } catch (err) {
        console.error("Error fatal al iniciar el servidor o conectar a la DB:", err);
        process.exit(1); // Termina la aplicación si hay un error crítico al inicio
    }
}

// Llama a startServer para iniciar todo el proceso
startServer();