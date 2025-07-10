const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

/**
 * Verifica email+password en WordPress (único método, siempre WP)
 */
async function verificarLoginWordPress(email, password) {
  try {
    const res = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })