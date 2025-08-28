# Dockerfile

# Usa una imagen oficial ligera de Node.js (LTS)
# Asegúrate de que sea compatible con tu aplicación y dependencias.
FROM node:18-slim
# O considera node:20-slim si tus dependencias lo requieren.

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia los archivos de gestión de dependencias (package.json y package-lock.json)
# Esto permite que Docker cachee la instalación de dependencias si estos archivos no cambian.
COPY package*.json ./

# Instala las dependencias de Node.js.
# --only=production: solo instala dependencias de producción.
# --ignore-scripts: evita la ejecución de scripts postinstall problemáticos.
# Ajusta la versión de Node si es necesario.
RUN npm install --only=production --ignore-scripts

# Copia el resto de los archivos de tu aplicación al directorio de trabajo.
# Asegúrate de tener un archivo .dockerignore para excluir node_modules y otros archivos innecesarios.
COPY . .

# Expone el puerto donde tu aplicación Node.js escuchará.
# Cloud Run te pasa la variable de entorno PORT, y tu aplicación debe leerla.
EXPOSE 8080

# Comando por defecto para iniciar tu aplicación.
# Asume que server.js es tu archivo de entrada principal.
CMD [ "node", "server.js" ]