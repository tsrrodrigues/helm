#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
npm install
echo ""
echo "✓ Helm instalado."
echo ""
echo "Para iniciar:"
echo "  npm start"
echo ""
echo "Para rodar como serviço background (autostart no login):"
echo "  npm run service"
