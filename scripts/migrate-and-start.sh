#!/bin/bash
set -e

export HOME=/tmp

echo "Running Prisma migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

echo "Starting Next.js server..."
node .next/standalone/server.js
