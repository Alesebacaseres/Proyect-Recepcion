require('dotenv').config();
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
        trustServerCertificate: true,
    }
};

function formatDate(date) {
    if (!date) return "–";
    try {
        return new Date(date).toLocaleString('es-ES');
    } catch (e) {
        console.error("Error al formatear fecha:", date, e);
        return "Fecha inválida";
    }
}

// --- RUTAS API ---
// (No modificadas, siguen igual que en tu versión)
// ...

// --- CLEAR ALL ---
app.delete('/api/clear-all', async (req, res) => {
    const transaction = new sql.Transaction();
    try {
        await transaction.begin();
        const request = transaction.request();
        await request.query('DELETE FROM Movimientos;');
        await request.query('DELETE FROM PalletsDescontados;');
        await request.query('DELETE FROM TareasDescuento;');
        await request.query('DELETE FROM PalletsEntrada;');
        await transaction.commit();

        res.json({ message: 'Todos los datos han sido borrados.' });
    } catch (err) {
        console.error('Error al borrar datos:', err);
        if (transaction) await transaction.rollback();
        res.status(500).json({ message: 'Error al borrar datos', error: err.message });
    }
});

// --- SERVIR INDEX SI EXISTE ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- INICIAR SERVIDOR Y CONECTAR DB ---
async function startServer() {
    try {
        await sql.connect(dbConfig);
        console.log("✅ Conexión a SQL Server establecida.");

        // Verificar/crear tablas si no existen
        const createTablesQuery = `
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

            IF OBJECT_ID('dbo.PalletsDescontados', 'U') IS NULL CREATE TABLE dbo.PalletsDescontados (
                ID INT PRIMARY KEY IDENTITY(1,1),
                TareaDescuentoID INT NOT NULL,
                Cliente VARCHAR(50) NOT NULL,
                CantidadDescontada INT NOT NULL,
                FechaHoraDescuento DATETIME NOT NULL DEFAULT GETDATE(),
                UsuarioDescuento VARCHAR(50) NULL,
                FOREIGN KEY (TareaDescuentoID) REFERENCES dbo.TareasDescuento(ID)
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

            IF OBJECT_ID('dbo.PalletsEntrada', 'U') IS NULL CREATE TABLE dbo.PalletsEntrada (
                ID INT PRIMARY KEY IDENTITY(1,1),
                Cliente VARCHAR(50) NOT NULL,
                Cantidad INT NOT NULL,
                FechaHoraIngreso DATETIME NOT NULL DEFAULT GETDATE(),
                UsuarioIngreso VARCHAR(50) NULL
            );
        `;
        const request = new sql.Request();
        await request.query(createTablesQuery);
        console.log("✅ Tablas verificadas/creadas.");

        app.listen(port, () => {
            console.log(`🚀 Servidor backend corriendo en http://localhost:${port}`);
        });

    } catch (err) {
        console.error("❌ Error al iniciar el servidor o conectar a la DB:", err);
        process.exit(1);
    }
}

startServer();

