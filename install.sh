#!/bin/bash
cd ~/helm
npm install
echo ""
echo "✓ Helm instalado."
echo ""
echo "Para iniciar:"
echo "  npm start"
echo ""
echo "Para autostart no login, adicione em System Settings → General → Login Items:"
echo "  $(which node) $(pwd)/start-all.js"
