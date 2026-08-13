                                                                                          require('dotenv').config();
const express = require('express');
const callRoutes = require('./routes/calls');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUIRED_ENV = ['OPENAI_API_KEY', 'BASE_URL', 'AZURE_TTS_KEY', 'AZURE_TTS_REGION'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ Faltan variables requeridas: ${missingEnv.join(', ')}`);
  process.exit(1);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => res.send('The Secret Spot IVR Server Running'));

app.use('/', callRoutes);

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
