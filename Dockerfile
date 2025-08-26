# Usa una imagen oficial ligera de Node.js (LTS)
FROM node:18-slim AS builder

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia los archivos de gestión de dependencias
COPY package*.json ./

# Instala solo dependencias de producción
RUN npm install --only=production

# Copia el resto de los archivos de tu aplicación
COPY . .

# Expone el puerto que Cloud Run espera (8080)
EXPOSE 8080

# Comando por defecto para iniciar la app
CMD ["npm", "start"]
