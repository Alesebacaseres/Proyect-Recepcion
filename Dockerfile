# Usa una imagen base de Node.js oficial.
# Elige una versión LTS recomendada (ej: 18-slim, 20-slim).
# Si tu app usa features de Node 20+, usa 'node:20-slim'. Si no, 18-slim está bien.
# He mantenido 18-slim ya que es una versión LTS común.
FROM node:18-slim AS builder

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia los archivos de gestión de dependencias (package.json, package-lock.json)
COPY package*.json ./

# Instala las dependencias del proyecto
# Es buena práctica usar '--only=production' si no necesitas devDependencies en producción
RUN npm install --only=production

# Copia el resto del código fuente de la aplicación al contenedor
COPY . .

# Indica que la aplicación escucha en el puerto 8080.
# Cloud Run asignará dinámicamente el puerto a través de la variable de entorno PORT.
# Tu aplicación Node.js debe leer process.env.PORT.
EXPOSE 8080

# Comando para iniciar la aplicación cuando el contenedor arranque.
# Asegúrate de que 'npm start' ejecute 'node server.js' y que server.js
# escuche en el puerto proporcionado por process.env.PORT.
CMD [ "npm", "start" ]