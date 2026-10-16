const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Clave de acceso (si defines APP_USER y APP_PASS en las variables de entorno)
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;
if (APP_USER && APP_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const i = decoded.indexOf(':');
      const u = decoded.slice(0, i);
      const p = decoded.slice(i + 1);
      if (u === APP_USER && p === APP_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Reporte de mantenciones"');
    res.status(401).send('Acceso restringido');
  });
}

// Filtros comunes: empresa y centro ($2 y $3). Vacío = todos.
const FILTROS = `
  fecha_dt IS NOT NULL
  AND ($2::text = '' OR LOWER(empresa) = LOWER($2))
  AND ($3::text = '' OR centro = $3)
`;

// Opciones para los desplegables de Empresa y Centro
app.get('/api/filtros', async (req, res) => {
  try {
    const empresas = await pool.query(`
      SELECT DISTINCT ON (LOWER(TRIM(empresa))) TRIM(empresa) AS empresa
      FROM mantenciones_final
      WHERE empresa IS NOT NULL AND TRIM(empresa) <> ''
      ORDER BY LOWER(TRIM(empresa)), TRIM(empresa)
    `);
    const centros = await pool.query(`
      SELECT DISTINCT centro
      FROM mantenciones_final
      WHERE centro IS NOT NULL AND TRIM(centro) <> ''
      ORDER BY centro
    `);
    res.json({
      empresas: empresas.rows.map(r => r.empresa),
      centros: centros.rows.map(r => r.centro),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al leer filtros' });
  }
});

// Todo el reporte en una sola llamada
app.get('/api/reporte', async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'mes debe tener formato AAAA-MM' });
    }
    const empresa = String(req.query.empresa || '');
    const centro = String(req.query.centro || '');
    const inicio = `${mes}-01`;

    // Mantenciones del mes elegido, por región y tipo
    const porRegion = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(ubicacion), ''), 'Sin ubicación') AS ubicacion,
             COUNT(*) FILTER (WHERE tipo = 'Remoto')::int  AS remoto,
             COUNT(*) FILTER (WHERE tipo = 'Terreno')::int AS terreno
      FROM mantenciones_final
      WHERE ${FILTROS}
        AND fecha_dt >= $1::date
        AND fecha_dt <  ($1::date + interval '1 month')
      GROUP BY 1
      ORDER BY 1
    `, [inicio, empresa, centro]);

    // Últimos 13 meses (hasta el mes elegido)
    const porMes = await pool.query(`
      SELECT to_char(date_trunc('month', fecha_dt), 'YYYY-MM') AS mes,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE tipo = 'Remoto')::int AS remoto
      FROM mantenciones_final
      WHERE ${FILTROS}
        AND fecha_dt >= ($1::date - interval '12 months')
        AND fecha_dt <  ($1::date + interval '1 month')
      GROUP BY 1
      ORDER BY 1
    `, [inicio, empresa, centro]);

    const remoto = porRegion.rows.reduce((a, r) => a + r.remoto, 0);
    const terreno = porRegion.rows.reduce((a, r) => a + r.terreno, 0);
    const [y, m] = mes.split('-').map(Number);
    const dias = new Date(y, m, 0).getDate();

    res.json({
      mes, dias, total: remoto + terreno, remoto, terreno,
      porRegion: porRegion.rows,
      porMes: porMes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al leer el reporte' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reporte de mantenciones en puerto ${PORT}`));
