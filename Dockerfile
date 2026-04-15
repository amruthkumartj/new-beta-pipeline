# Use official Node.js runtime as a lightweight base image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package manifests and install dependencies first for better caching
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

# Expose default listening port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
