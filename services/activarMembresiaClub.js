require('dotenv').config();
const fetch = require('node-fetch');
const qs = require('qs');

const MP_SITE_URL = process.env.MP_SITE_URL;
const MP_ADMIN_USER = process.env.MP_ADMIN_USER;
const MP_ADMIN_PASS = process.env.MP_ADMIN_PASS;
const CLUB_MEMBERSHIP_ID = '10663';

async function activarMembresiaClub(emailUsuario) {
  try {
    console.log(`🔐 Activando membresía del Club para: ${emailUsuario}`);

    // 1. Login para obtener cookie de sesión WP
    const loginResp = await fetch(`${MP_SITE_URL}/wp-login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: qs.stringify({
        log: MP_ADMIN_USER,
        pwd: MP_ADMIN_PASS,
        wp-submit: 'Acceder',
        redirect_to: `${MP_SITE_URL}/wp-admin/`,
        testcookie: 1
      }),
      redirect: 'manual'
    });

    const cookies = loginResp.headers.raw()['set-cookie'];
    if (!cookies) throw new Error('❌ No se pudo obtener cookie de sesión WordPress');

    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');

    // 2. Activar membresía del Club (MemberPress)
    const mpResp = await fetch(`${MP_SITE_URL}/wp-json/mp/v1/memberships/${CLUB_MEMBERSHIP_ID}/add-member`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieString
      },
      body: JSON.stringify({ email: emailUsuario })
    });

    const resultado = await mpResp.json();

    if (!mpResp.ok || resultado.error) {
      console.error('❌ Error al activar membresía del Club:', resultado);
      throw new Error('Error al activar membresía del Club');
    }

    console.log(`✅ Membresía del Club activada para ${emailUsuario}`);
    return true;
  } catch (err) {
    console.error('❌ Error en activarMembresiaClub:', err.message);
    throw err;
  }
}

module.exports = { activarMembresiaClub };
