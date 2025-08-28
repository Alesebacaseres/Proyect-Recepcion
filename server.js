// Importa los módulos necesarios
const express = require('express');
const cors = require('cors');
const tedious = require('tedious');
const os = require('os'); // Ya no lo usaremos directamente, pero lo dejamos si otros módulos lo necesitan.

// Inicializa la aplicación Express
const app = express();

// Middleware para permitir CORS y parsear JSON
app.use(cors());
app.use(express.json());

// --- Configuración de la Base de Datos ---
// Lee las variables de entorno directamente de process.env
const dbServer = process.env.DB_SERVER;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbDatabase = process.env.DB_DATABASE;
const appPort = parseInt(process.env.PORT, 10) || 8080;

// --- Verificación de Variables de Entorno Críticas ---
// Realizamos una validación más estricta para asegurarnos de que no sean cadenas vacías.
console.log("--- Verificando variables de entorno ---");
console.log(`DB_SERVER: '${dbServer}'`);
console.log(`DB_USER: '${dbUser}'`);
console.log(`DB_PASSWORD: '${dbPassword ? '******' : 'null'}'`); // No mostramos la contraseña real
console.log(`DB_DATABASE: '${dbDatabase}'`);
console.log(`PORT: '${appPort}'`); // Usamos appPort porque ya lo parseamos
console.log("---------------------------------------");

if (!dbServer || dbServer.trim() === "") {
    console.error("ERROR: La variable de entorno DB_SERVER está vacía o no definida.");
    process.exit(1);
}
if (!dbUser || dbUser.trim() === "") {
    console.error("ERROR: La variable de entorno DB_USER está vacía o no definida.");
    process.exit(1);
}
if (!dbPassword || dbPassword.trim() === "") {
    console.error("ERROR: La variable de entorno DB_PASSWORD está vacía o no definida.");
    process.exit(1);
}
if (!dbDatabase || dbDatabase.trim() === "") {
    console.error("ERROR: La variable de entorno DB_DATABASE está vacía o no definida.");
    process.exit(1);
}
if (isNaN(appPort) || appPort <= 0) {
    console.error("ERROR: El puerto de la aplicación (PORT) no es un número válido.");
    process.exit(1);
}

// --- Configuración para la librería 'tedious' ---
const dbConfig = {
    server: dbServer, // El nombre del servidor (IP o hostname)
    authentication: {
        type: 'default', // Para usar el login/password de SQL Server
        options: {
            userName: dbUser,     // <-- Aquí se usa la variable leída de process.env.DB_USER
            password: dbPassword  // <-- Aquí se usa la variable leída de process.env.DB_PASSWORD
        }
    },
    options: {
        database: dbDatabase, // <-- Aquí se usa la variable leída de process.env.DB_DATABASE
        port: 1433,           // Puerto estándar de SQL Server.
        encrypt: true,
        trustServerCertificate: true,     // Descomenta si tu servidor requiere SSL/TLS. Prueba sin él primero si falla la conexión.
    }
};

// --- Lógica de Conexión a la Base de Datos ---
let connection = null;
let isDbConnected = false;

function connectToDatabase() {
    return new Promise((resolve, reject) => {
        try {
            // Creamos una nueva instancia de conexión con la configuración correcta
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
                process.exit(1); // Salimos si hay un error crítico en la conexión
            });

            console.log("Intentando conectar a la base de datos con config:", { server: dbServer, user: dbUser, database: dbDatabase, port: 1433 }); // Log para depurar config
            connection.connect();
        } catch (err) {
            console.error('ERROR al crear la instancia de conexión:', err);
            isDbConnected = false;
            reject(err);
        }
    });
}

// Función auxiliar para formatear fechas (asegúrate de que sea usada y manejada correctamente)
function formatDate(date) {
    if (!date) return "–";
    try {
        if (date instanceof Date && !isNaN(date.getTime())) {
            return date.toLocaleString('es-ES', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
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
async function executeQuery(query, params) {
    if (!connection || !isDbConnected) {
        // Si la conexión no está lista, lanzamos un error
        throw new Error("No hay conexión activa a la base de datos.");
    }

    return new Promise((resolve, reject) => {
        const request = new tedious.Request(query, (err, rowCount, rows) => {
            if (err) {
                console.error('ERROR en la ejecución de la consulta:', err);
                reject(err);
            } else {
                resolve({ rowCount, rows });
            }
        });

        // Añadimos los parámetros a la consulta usando los tipos de tedious
        if (params) {
            for (const param of params) {
                if (param.name && param.type !== undefined && param.value !== undefined) {
                    request.addParameter(param.name, param.type, param.value);
                } else {
                    console.warn("Parámetro de consulta inválido:", param);
                }
            }
        }
        connection.execSql(request); // Ejecuta la consulta
    });
}

// --- Rutas de la API ---

// Ruta para obtener el estado general (KPIs)
app.get('/api/status', async (req, res) => {
    try {
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

        // Para lastIngreso y lastDescuento, necesitarás asegurarte de que las fechas sean manejables por formatDate.
        // El resultado de las queries de 'tedious' puede necesitar un procesamiento adicional para obtener objetos Date.
        const lastIngresoResult = await executeQuery('SELECT TOP 1 Cliente, Cantidad, FechaHoraIngreso FROM PalletsEntrada ORDER BY FechaHoraIngreso DESC');
        const lastDescuentoResult = await executeQuery('SELECT TOP 1 T.Cliente, PD.CantidadDescontada, PD.FechaHoraDescuento FROM PalletsDescontados PD JOIN TareasDescuento T ON PD.TareaDescuentoID = T.ID ORDER BY PD.FechaHoraDescuento DESC');

        let ultimaAccion = "–";
        if (lastIngresoResult.rows.length > 0 && lastDescuentoResult.rows.length > 0) {
            const ingresoData = lastIngresoResult.rows[0];
            const descuentoData = lastDescuentoResult.rows[0];

            // Asegurarse de que las fechas sean objetos Date o strings manejables por formatDate
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
        // Asegúrate de que los tipos de datos de los parámetros coincidan con los de tu base de datos.
        const params = [{ name: 'searchTerm', type: tedious.TYPES.VarChar, value: `%${searchTerm}%` }];
        const result = await executeQuery(query, params);

        res.json(result.rows);
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
    if (!cliente || typeof cliente !== 'string' || cliente.trim() === "") {
        return res.status(400).json({ message: 'Cliente es requerido y debe ser válido.' });
    }
    if (!cantidad || typeof cantidad !== 'number' || cantidad <= 0) {
        return res.status(400).json({ message: 'Cantidad es requerida y debe ser un número positivo.' });
    }
    if (!UsuarioIngreso || typeof UsuarioIngreso !== 'string' || UsuarioIngreso.trim() === "") {
        return res.status(400).json({ message: 'Usuario es requerido y debe ser válido.' });
    }

    // --- INSERCIÓN EN LA BASE DE DATOS ---
    try {
        const insertRequest = connection.request(); // Usamos la conexión global
        const insertResult = await insertRequest
            .input('cliente', tedious.TYPES.VarChar, cliente)
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
        // Comprobar disponibilidad y crear tarea/movimiento usando la conexión global

        // PRIMER QUERY: Chequeo de disponibilidad
        const checkRequest = connection.request(); // Usamos la conexión global
        const availableCheckResult = await checkRequest
            .input('PalletEntradaID', tedious.TYPES.Int, PalletEntradaID)
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

        // SEGUNDO QUERY: Inserción de tarea
        const insertTaskRequest = connection.request(); // Usamos la conexión global
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

        // TERCER QUERY: Movimiento
        const movimientoRequest = connection.request(); // Usamos la conexión global
        await movimientoRequest
            .input('cliente', tedious.TYPES.VarChar, cliente)
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
        // Si hay un error, hacemos rollback de la transacción si existe
        if (connection && connection.rollback) {
            await connection.rollback();
        }
        res.status(500).json({ message: 'Error al generar tarea de descuento', error: err.message });
    }
});

// Ruta para obtener las tareas de descuento pendientes
app.get('/api/tareas-descuento', async (req, res) => {
    const searchTerm = req.query.search || '';
    try {
        const request = connection.request(); // Usamos la conexión global

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
        // Por ahora, asumimos que no hay parámetros para esta consulta específica.
        // Si searchTerm se aplica a Cliente, necesitarías:
        // const params = [{ name: 'searchTerm', type: tedious.TYPES.VarChar, value: `%${searchTerm}%` }];
        // const result = await executeQuery(query, params); // Aquí 'executeQuery' necesitaría adaptarse para usar 'connection'

        // Si usas 'request' directamente de la 'connection':
        const result = await request.query(query);

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
        // Necesitas asegurarte de que las operaciones de base de datos estén dentro de una transacción.
        const transaction = connection.transaction(); // Asumiendo que 'connection' tiene un método transaction()
        await transaction.begin();

        // Primer request - obtener tarea
        const tareaResult = await transaction.request() // Usando el request de la transacción
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .query('SELECT * FROM TareasDescuento WHERE ID = @tareaId');

        if (tareaResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Tarea no encontrada' });
        }

        const tarea = tareaResult.recordset[0];

        // Segundo request - verificar descuento acumulado
        const descontadoTareaResult = await transaction.request() // Usando el request de la transacción
            .input('tareaId', tedious.TYPES.Int, tareaId)
            .query('SELECT SUM(CantidadDescontada) as TotalDescontado FROM PalletsDescontados WHERE TareaDescuentoID = @tareaId');

        const descontadoHastaAhora = descontadoTareaResult.recordset[0].TotalDescontado || 0;
        const cantidadPendienteEnTarea = tarea.CantidadSolicitada - descontadoHastaAhora;

        if (cantidadADescontar <= 0 || cantidadADescontar > cantidadPendienteEnTarea) {
            await transaction.rollback();
            return res.status(400).json({ message: `Cantidad inválida. Pendiente en tarea: ${cantidadPendienteEnTarea}` });
        }

        // Tercer request - insertar descuento
        const insertDescuentoResult = await transaction.request() // Usando el request de la transacción
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
            await transaction.request() // Usando el request de la transacción
                .input('tareaId', tedious.TYPES.Int, tareaId)
                .query('UPDATE TareasDescuento SET Estado = \'Completada\' WHERE ID = @tareaId');
        }

        // Quinto request - registrar movimiento
        await transaction.request() // Usando el request de la transacción
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

        await transaction.commit();
        res.json({ message: 'Pallet descontado con éxito', id: palletDescontadoId });

    } catch (err) {
        console.error('Error al descontar pallet:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al descontar pallet', error: err.message });
    }
});

// --- Servir el frontend ---
// Asegúrate de que 'index.html' esté en la raíz del proyecto junto a server.js
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Inicio del servidor ---
async function startServer() {
    try {
        await connectToDatabase(); // Intenta conectar a la base de datos primero

        // --- Creación de tablas si no existen ---
        // Esto es útil para el desarrollo inicial o para asegurar que el esquema esté presente.
        // En entornos de producción, es mejor tener las migraciones de esquema separadas.
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

        // Ejecuta la creación de tablas usando la conexión global
        const createTablesRequest = connection.request(); // Obteniendo request de la conexión
        await createTablesRequest.query(createTablesQuery);
        console.log("Tablas verificadas/creadas exitosamente.");

        // Inicia el servidor web solo después de que la conexión a la BD sea exitosa
        app.listen(appPort, () => {
            console.log(`Servidor web escuchando en el puerto ${appPort}`);
        });

    } catch (err) {
        // Si hay un error al conectar a la BD o al crear tablas, salimos.
        console.error("ERROR FATAL al iniciar el servidor o conectar a la DB:", err);
        process.exit(1);
    }
}

// Llama a startServer para iniciar todo el proceso
startServer();