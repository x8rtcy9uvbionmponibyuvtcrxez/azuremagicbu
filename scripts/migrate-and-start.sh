#!/bin/bash
set -e

export HOME=/tmp

echo "Running Prisma migrations..."
./node_modules/.bin/prisma migrate deploy

echo "Starting Next.js server..."
node server.js
