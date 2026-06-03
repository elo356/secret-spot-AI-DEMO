require('dotenv').config();
const express = require('express');
const callRoutes = require('./routes/calls');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => res.send('The Secret Spot – IVR Server Running ✅'));

app.use('/', callRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
