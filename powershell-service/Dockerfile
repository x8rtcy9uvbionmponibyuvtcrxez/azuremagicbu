FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PS_SERVICE_PORT=3099

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget gnupg apt-transport-https ca-certificates \
  && wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
  && dpkg -i packages-microsoft-prod.deb \
  && rm packages-microsoft-prod.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends powershell \
  && rm -rf /var/lib/apt/lists/*

RUN pwsh -NoLogo -NoProfile -Command "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; Install-Module ExchangeOnlineManagement -RequiredVersion 3.7.1 -Scope AllUsers -Force -AllowClobber"

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3099
CMD ["node", "server.js"]
