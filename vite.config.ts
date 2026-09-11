import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  server:{
    port:4173,
    host:true,
    proxy:{'/api':'http://127.0.0.1:8820'}
  },
  preview:{
    port:4173,
    host:true,
    proxy:{'/api':'http://127.0.0.1:8820'}
  },
  build:{outDir:'dist-web'}
});
