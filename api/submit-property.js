import crypto from 'crypto';
import { logError, notifyAdminWhatsApp } from '../lib/notify.js';
import { isRateLimited } from '../lib/rate-limit.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function safeCompareStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

async function checkAdminAuth(req, providedPassword, serviceKey) {
  const ip = getClientIp(req);
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}&select=id`,
      { headers }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length >= MAX_ATTEMPTS) {
        return { ok: false, status: 429, error: 'Too many failed attempts. Try again in a few minutes.' };
      }
    }
  } catch (e) {
    console.error('submit-property auth: rate-limit check failed:', e.message);
  }
  const correct = safeCompareStr(providedPassword, process.env.ADMIN_PASSWORD);
  if (!correct) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ ip }),
      });
    } catch (e) {
      console.error('submit-property auth: failed to log attempt:', e.message);
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

// Nigeria's 36 states + FCT, each mapped to its official LGAs (774 total).
// Kept in sync with the same dataset embedded in list-property.html — this is the
// server-side source of truth so a spoofed/direct API request can't submit a
// state or LGA combination that doesn't actually exist.
const LGA_DATA = {"Abia":["Aba North","Aba South","Arochukwu","Bende","Ikwuano","Isiala Ngwa North","Isiala Ngwa South","Isuikwuato","Obi Ngwa","Ohafia","Osisioma","Ugwunagbo","Ukwa East","Ukwa West","Umu-Nneochi","Umuahia North","Umuahia South"],"Abuja":["Abaji","Abuja","Bwari","Gwagwalada","Kuje","Kwali"],"Adamawa":["Demsa","Fufore","Ganye","Girei","Gombi","Guyuk","Hong","Jada","Lamurde","Madagali","Maiha","Mayo Belwa","Michika","Mubi North","Mubi South","Numan","Shelleng","Song","Toungo","Yola North","Yola South"],"Akwa Ibom":["Abak","Eastern Obolo","Eket","Esit Eket","Essien Udim","Etim Ekpo","Etinan","Ibeno","Ibesikpo Asutan","Ibiono Ibom","Ika","Ikono","Ikot Abasi","Ikot Ekpene","Ini","Itu","Mbo","Mkpat Enin","Nsit Atai","Nsit Ibom","Nsit Ubium","Obot Akara","Okobo","Onna","Oron","Oruk Anam","Udung Uko","Ukanafun","Uruan","Urue Offong/Oruko","Uyo"],"Anambra":["Aguata","Anambra East","Anambra West","Anaocha","Awka North","Awka South","Ayamelum","Dunukofia","Ekwusigo","Idemili North","Idemili South","Ihiala","Njikoka","Nnewi North","Nnewi South","Ogbaru","Onitsha North","Onitsha South","Orumba North","Orumba South","Oyi"],"Bauchi":["Alkaleri","Bauchi","Bogoro","Damban","Darazo","Dass","Gamawa","Ganjuwa","Giade","Itas/Gadau","Jama'are","Katagum","Kirfi","Misau","Ningi","Shira","Tafawa Balewa","Toro","Warji","Zaki"],"Bayelsa":["Brass","Ekeremor","Kolokuma/Opokuma","Nembe","Ogbia","Sagbama","Southern Ijaw","Yenagoa"],"Benue":["Ado","Agatu","Apa","Buruku","Gboko","Guma","Gwer East","Gwer West","Katsina Ala","Konshisha","Kwande","Logo","Makurdi","Obi","Ogbadibo","Ohimini","Oju","Okpokwu","Otukpo","Tarka","Ukum","Ushongo","Vandeikya"],"Borno":["Abadam","Askira/Uba","Bama","Bayo","Biu","Chibok","Damboa","Dikwa","Gubio","Guzamala","Gwoza","Hawul","Jere","Kaga","Kala/Balge","Konduga","Kukawa","Kwaya Kusar","Mafa","Magumeri","Maiduguri","Marte","Mobbar","Monguno","Ngala","Nganzai","Shani"],"Cross River":["Abi","Akamkpa","Akpabuyo","Bakassi","Bekwarra","Biase","Boki","Calabar Municipal","Calabar South","Etung","Ikom","Obanliku","Obubra","Obudu","Odukpani","Ogoja","Yakurr","Yala"],"Delta":["Aniocha North","Aniocha South","Bomadi","Burutu","Ethiope East","Ethiope West","Ika North East","Ika South","Isoko North","Isoko South","Ndokwa East","Ndokwa West","Okpe","Oshimili North","Oshimili South","Patani","Sapele","Udu","Ughelli North","Ughelli South","Ukwuani","Uvwie","Warri North","Warri South","Warri South West"],"Ebonyi":["Abakaliki","Afikpo North","Afikpo South","Ebonyi","Ezza North","Ezza South","Ikwo","Ishielu","Ivo","Izzi","Ohaozara","Ohaukwu","Onicha"],"Edo":["Akoko Edo","Egor","Esan Central","Esan North East","Esan South East","Esan West","Etsako Central","Etsako East","Etsako West","Igueben","Ikpoba Okha","Oredo","Orhionmwon","Ovia North East","Ovia South West","Owan East","Owan West","Uhunmwonde"],"Ekiti":["Ado-Ekiti","Efon","Ekiti East","Ekiti South West","Ekiti West","Emure","Gbonyin","Ido-Osi","Ijero","Ikere","Ikole","Ilejemeje","Irepodun/Ifelodun","Ise/Orun","Moba","Oye"],"Enugu":["Aninri","Awgu","Enugu East","Enugu North","Enugu South","Ezeagu","Igbo Etiti","Igbo Eze North","Igbo Eze South","Isi-Uzo","Nkanu East","Nkanu West","Nsukka","Oji-River","Udenu","Udi","Uzo-Uwani"],"Gombe":["Akko","Balanga","Billiri","Dukku","Funakaye","Gombe","Kaltungo","Kwami","Nafada","Shongom","Yamaltu/Deba"],"Imo":["Aboh Mbaise","Ahiazu Mbaise","Ehime Mbano","Ezinihitte Mbaise","Ideato North","Ideato South","Ihitte/Uboma","Ikeduru","Isiala Mbano","Isu","Mbaitoli","Ngor Okpala","Njaba","Nkwerre","Nwangele","Obowo","Oguta","Ohaji/Egbema","Okigwe","Onuimo","Orlu","Orsu","Oru East","Oru West","Owerri Municipal","Owerri North","Owerri West"],"Jigawa":["Auyo","Babura","Biriniwa","Birnin Kudu","Buji","Dutse","Gagarawa","Garki","Gumel","Guri","Gwaram","Gwiwa","Hadejia","Jahun","Kafin Hausa","Kaugama","Kazaure","Kiri Kasama","Kiyawa","Maigatari","Malam Madori","Miga","Ringim","Roni","Sule Tankarkar","Taura","Yankwashi"],"Kaduna":["Birnin Gwari","Chikun","Giwa","Igabi","Ikara","Jaba","Jema'a","Kachia","Kaduna North","Kaduna South","Kagarko","Kajuru","Kaura","Kauru","Kubau","Kudan","Lere","Makarfi","Sabon Gari","Sanga","Soba","Zangon Kataf","Zaria"],"Kano":["Ajingi","Albasu","Bagwai","Bebeji","Bichi","Bunkure","Dala","Dambatta","Dawakin Kudu","Dawakin Tofa","Doguwa","Fagge","Gabasawa","Garko","Garun Malam","Gaya","Gezawa","Gwale","Gwarzo","Kabo","Kano Municipal","Karaye","Kibiya","Kiru","Kunchi","Kura","Madobi","Makoda","Minjibir","Nasarawa","Rano","Rimin Gado","Rogo","Shanono","Sumaila","Takai","Tarauni","Tofa","Tsanyawa","Tudun Wada","Ungogo","Warawa","Wudil","kumbotso"],"Katsina":["Bakori","Batagarawa","Batsari","Baure","Bindawa","Charanchi","Dan Musa","DanDume","Danja","Daura","Dutsi","Dutsin-Ma","Faskari","Funtua","Ingawa","Jibia","Kafur","Kaita","Kankara","Kankia","Katsina","Kurfi","Kusada","Mai'Adua","Malumfashi","Mani","Mashi","Matazu","Musawa","Rimi","Sabuwa","Safana","Sandamu","Zango"],"Kebbi":["Aliero","Arewa Dandi","Argungu","Augie","Bagudo","Birnin Kebbi","Bunza","Dandi","Danko-Wasagu","Fakai","Gwandu","Jega","Kalgo","Koko/Besse","Maiyama","Ngaski","Sakaba","Shanga","Suru","Yauri","Zuru"],"Kogi":["Adavi","Ajaokuta","Ankpa","Bassa","Dekina","Ibaji","Idah","Igalamela Odolu","Ijumu","Kabba/Bunu","Kogi","Lokoja","Mopa-Muro","Ofu","Ogori/Magongo","Okehi","Okene","Olamaboro","Omala","Yagba East","Yagba West"],"Kwara":["Asa","Baruten","Edu","Ekiti","Ifelodun","Ilorin East","Ilorin South","Ilorin West","Irepodun","Isin","Kaiama","Moro","Offa","Oke-Ero","Oyun","Pategi"],"Lagos":["Agege","Ajeromi-Ifelodun","Alimosho","Amuwo-Odofin","Apapa","Badagry","Epe","Eti-Osa","Ibeju-Lekki","Ifako-Ijaiye","Ikeja","Ikorodu","Kosofe","Lagos Island","Lagos Mainland","Mushin","Ojo","Oshodi-Isolo","Somolu","Surulere"],"Nasarawa":["Akwanga","Awe","Doma","Karu","Keana","Keffi","Kokona","Lafia","Nasarawa","Nasarawa Egon","Obi","Toto","Wamba"],"Niger":["Agaie","Agwara","Bida","Borgu","Bosso","Chanchaga","Edati","Gbako","Gurara","Katcha","Kontagora","Lapai","Lavun","Magama","Mariga","Mashegu","Mokwa","Munya","Paikoro","Rafi","Rijau","Shiroro","Suleja","Tafa","Wushishi"],"Ogun":["Abeokuta North","Abeokuta South","Ado-Odo/Ota","Ewekoro","Ifo","Ijebu East","Ijebu North","Ijebu North East","Ijebu Ode","Ikenne","Imeko Afon","Ipokia","Obafemi Owode","Odeda","Odogbolu","Ogun Waterside","Remo North","Shagamu","Yewa North","Yewa South"],"Ondo":["Akoko North East","Akoko North West","Akoko South East","Akoko South West","Akure North","Akure South","Ese Odo","Idanre","Ifedore","Ilaje","Ile Oluji/Okeigbo","Irele","Odigbo","Okitipupa","Ondo East","Ondo West","Ose","Owo"],"Osun":["Aiyedire","Atakunmosa East","Atakunmosa West","Ayedaade","Boluwaduro","Boripe","Ede North","Ede South","Egbedore","Ejigbo","Ife Central","Ife East","Ife North","Ife South","Ifedayo","Ifelodun","Ila","Ilesa East","Ilesa West","Irepodun","Irewole","Isokan","Iwo","Obokun","Odo-Otin","Ola-Oluwa","Olorunda","Oriade","Orolu","Osogbo"],"Oyo":["Afijio","Akinyele","Atiba","Atisbo","Egbeda","Ibadan North","Ibadan North East","Ibadan North West","Ibadan South East","Ibadan South West","Ibarapa Central","Ibarapa East","Ibarapa North","Ido","Irepo","Iseyin","Itesiwaju","Iwajowa","Kajola","Lagelu","Ogbomosho North","Ogbomosho South","Ogo Oluwa","Olorunsogo","Oluyole","Ona Ara","Oorelope","Ori Ire","Oyo East","Oyo West","Saki East","Saki West","Surulere"],"Plateau":["Barkin Ladi","Bassa","Bokkos","Jos East","Jos North","Jos South","Kanam","Kanke","Langtang North","Langtang South","Mangu","Mikang","Pankshin","Qua'an Pan","Riyom","Shendam","Wase"],"Rivers":["Abua-Odual","Ahoada East","Ahoada West","Akuku-Toru","Andoni","Asari-Toru","Bonny","Degema","Eleme","Emohua","Etche","Gokana","Ikwerre","Khana","Obio/Akpor","Ogba/Egbema/Ndoni","Ogu/Bolo","Okrika","Omuma","Opobo/Nkoro","Oyigbo","Port Harcourt","Tai"],"Sokoto":["Binji","Bodinga","Dange/Shuni","Gada","Goronyo","Gudu","Gwadabawa","Illela","Isa","Kebbe","Kware","Rabah","Sabon Birni","Shagari","Silame","Sokoto North","Sokoto South","Tambuwal","Tangaza","Tureta","Wamako","Wurno","Yabo"],"Taraba":["Ardo Kola","Bali","Donga","Gashaka","Gassol","Ibi","Jalingo","Karim Lamido","Kurmi","Lau","Sardauna","Takum","Ussa","Wukari","Yorro","Zing"],"Yobe":["Bade","Bursari","Damaturu","Fika","Fune","Geidam","Gujba","Gulani","Jakusko","Karasuwa","Machina","Nangere","Nguru","Potiskum","Tarmuwa","Yunusari","Yusufari"],"Zamfara":["Anka","Bakura","Birnin Magaji/Kiyaw","Bukkuyum","Bungudu","Gummi","Gusau","Kaura Namoda","Maradun","Maru","Shinkafi","Talata Mafara","Tsafe","Zurmi"]};
const CITIES = Object.keys(LGA_DATA);
const TYPES = ['self-con', 'mini-flat', 'flat', 'duplex', 'bungalow', 'terrace', 'mansion'];
const FLOOD_RISKS = ['Low risk', 'Moderate risk', 'High risk'];

// Escapes HTML special characters. The frontend renders several of these fields
// via innerHTML (property detail modal, cards, etc.) without escaping — so this
// is the one place stopping a malicious listing from running a script in every
// visitor's browser (stored XSS), not just data-quality cleanup.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, max) {
  return String(str).slice(0, max);
}


// Encrypts a NIN with AES-256-GCM before it's ever written to the database.
// This is field-level encryption on top of Supabase's own disk-level encryption —
// it protects against a leaked/compromised SUPABASE_SERVICE_ROLE_KEY being used to
// read the raw table directly, since even with full DB read access, nin_number is
// ciphertext without this app's separate NIN_ENCRYPTION_KEY (never stored in Supabase).
function encryptNin(plaintext) {
  const key = Buffer.from(process.env.NIN_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// Validates and normalizes the submission. Returns { error: '...' } on the
// first problem found, or { data: {...} } with clean, safe values ready to insert.
function validateProperty(body) {
  const name = truncate(escapeHtml((body.name || '').trim()), 100);
  if (!name) return { error: 'Property title is required' };

  const area = truncate(escapeHtml((body.area || '').trim()), 100);
  if (!area) return { error: 'Area/neighbourhood is required' };

  const city = (body.city || '').trim();
  if (!CITIES.includes(city)) return { error: 'Invalid state' };

  const lga = (body.lga || '').trim();
  if (!LGA_DATA[city] || !LGA_DATA[city].includes(lga)) {
    return { error: 'Invalid LGA for the selected state' };
  }

  const type = (body.type || '').trim();
  if (!TYPES.includes(type)) return { error: 'Invalid property type' };

  const price = parseInt(body.price, 10);
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000_000) {
    return { error: 'Invalid price' };
  }

  const bedrooms = parseInt(body.bedrooms, 10);
  if (!Number.isFinite(bedrooms) || bedrooms < 1 || bedrooms > 20) {
    return { error: 'Invalid number of bedrooms' };
  }
  const bathrooms = parseInt(body.bathrooms, 10);
  if (!Number.isFinite(bathrooms) || bathrooms < 1 || bathrooms > 20) {
    return { error: 'Invalid number of bathrooms' };
  }

  // Fee breakdown — optional (not every landlord knows exact figures upfront),
  // but validated if provided so we never store garbage. Agency/legal fees are
  // conventionally a % of annual rent in Nigeria; caution fee is a flat refundable
  // deposit amount.
  let agencyFeePercent = null;
  if (body.agency_fee_percent !== undefined && body.agency_fee_percent !== null && body.agency_fee_percent !== '') {
    agencyFeePercent = parseFloat(body.agency_fee_percent);
    if (!Number.isFinite(agencyFeePercent) || agencyFeePercent < 0 || agencyFeePercent > 100) {
      return { error: 'Agency fee must be a percentage between 0 and 100' };
    }
  }
  let legalFeePercent = null;
  if (body.legal_fee_percent !== undefined && body.legal_fee_percent !== null && body.legal_fee_percent !== '') {
    legalFeePercent = parseFloat(body.legal_fee_percent);
    if (!Number.isFinite(legalFeePercent) || legalFeePercent < 0 || legalFeePercent > 100) {
      return { error: 'Legal fee must be a percentage between 0 and 100' };
    }
  }
  let cautionFee = null;
  if (body.caution_fee !== undefined && body.caution_fee !== null && body.caution_fee !== '') {
    cautionFee = parseFloat(body.caution_fee);
    if (!Number.isFinite(cautionFee) || cautionFee < 0 || cautionFee > 1_000_000_000) {
      return { error: 'Invalid caution fee amount' };
    }
  }

  const description = truncate(escapeHtml((body.description || '').trim()), 2000);

  const rawAmenities = Array.isArray(body.amenities) ? body.amenities : [];
  const amenities = rawAmenities.slice(0, 30).map((a) => truncate(escapeHtml(String(a)), 50));

  const landlordName = truncate(escapeHtml((body.landlord_name || '').trim()), 100);
  if (!landlordName) return { error: 'Landlord name is required' };

  const phoneDigits = (body.landlord_phone || '').replace(/[^\d+]/g, '');
  if (!/^(\+?234\d{10}|0\d{10})$/.test(phoneDigits)) {
    return { error: 'Please enter a valid Nigerian phone number' };
  }

  let landlordEmail = (body.landlord_email || '').trim();
  if (landlordEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(landlordEmail) || landlordEmail.length > 254) {
      return { error: 'Please enter a valid email address' };
    }
    landlordEmail = escapeHtml(landlordEmail);
  }

  const ninNumber = (body.nin_number || '').trim();
  if (!/^\d{11}$/.test(ninNumber)) {
    return { error: 'NIN must be exactly 11 digits' };
  }
  if (!process.env.NIN_ENCRYPTION_KEY) {
    return { error: 'Server misconfigured: NIN_ENCRYPTION_KEY is not set' };
  }
  const encryptedNin = encryptNin(ninNumber);

  const securityInfo = truncate(escapeHtml((body.security_info || '').trim()), 300);
  if (!securityInfo) return { error: 'Security info is required' };
  const waterInfo = truncate(escapeHtml((body.water_info || '').trim()), 300);
  if (!waterInfo) return { error: 'Water info is required' };
  const electricityInfo = truncate(escapeHtml((body.electricity_info || '').trim()), 300);
  if (!electricityInfo) return { error: 'Electricity info is required' };

  const floodRisk = (body.flood_risk || '').trim();
  if (!FLOOD_RISKS.includes(floodRisk)) return { error: 'Invalid flood risk value' };

  const nearbySchools = truncate(escapeHtml((body.nearby_schools || '').trim()), 300);
  const nearbyMarkets = truncate(escapeHtml((body.nearby_markets || '').trim()), 300);

  const rawPhotoUrls = Array.isArray(body.photo_urls) ? body.photo_urls : [];
  const expectedPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/property-photos/`;
  const photoUrls = rawPhotoUrls
    .filter((u) => typeof u === 'string' && u.startsWith(expectedPrefix))
    .slice(0, 10);
  if (photoUrls.length < 3) {
    return { error: 'At least 3 valid property photos are required' };
  }

  return {
    data: {
      name, area, city, lga, type, price, bedrooms, bathrooms, description, amenities,
      landlord_name: landlordName, landlord_phone: phoneDigits, landlord_email: landlordEmail,
      nin_number: encryptedNin, security_info: securityInfo, water_info: waterInfo,
      electricity_info: electricityInfo, flood_risk: floodRisk,
      nearby_schools: nearbySchools, nearby_markets: nearbyMarkets, photo_urls: photoUrls,
      agency_fee_percent: agencyFeePercent, legal_fee_percent: legalFeePercent, caution_fee: cautionFee,
    },
  };
}

// Public report action — rate-limited to 3 per IP per hour so this can't be
// used to spam the admin WhatsApp. No persistence to a table for now (this
// is meant to be low-effort and immediate, matching how disputes alert you);
// if report volume ever justifies a dedicated dashboard view, that's an easy
// follow-up, not a reason to hold back a working fix today.
async function reportListing(req, res, body) {
  const { property_id, reason } = body;
  if (!property_id) return res.status(400).json({ error: 'Missing property_id' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ip = getClientIp(req);
  const limited = await isRateLimited(`report:${ip}`, 3, 60, serviceKey);
  if (limited) {
    return res.status(429).json({ error: 'Too many reports from this device — please try again later' });
  }

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const propResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${property_id}&select=name,area,city`, { headers }
  );
  const props = await propResp.json();
  const property = props[0];
  const propertyLabel = property ? `${property.name} — ${property.area}, ${property.city}` : `Property #${property_id}`;

  const cleanReason = reason ? String(reason).slice(0, 500) : '(no reason given)';
  await notifyAdminWhatsApp(
    `🚩 Listing reported as suspicious: ${propertyLabel} (id ${property_id})\nReason: ${cleanReason}\nReview in the admin dashboard.`
  );

  return res.status(200).json({ success: true });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body;

    // Public "Report suspicious listing" action — no auth, anyone can flag a
    // listing. Was previously a fake button that just showed an alert() and
    // did nothing; this is what actually makes it reach the admin.
    if (body.action === 'report_listing') {
      return await reportListing(req, res, body);
    }

    // Two ways in: a signed-in user's access token (normal landlord self-submission,
    // goes to 'pending' for review), or the admin password (quick-add tool for
    // seeding real listings — auto-approved since the admin is personally vetting
    // the data as they type it in, no separate review step needed).
    let user = null;
    let isAdminEntry = false;

    if (body.admin_password) {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const auth = await checkAdminAuth(req, body.admin_password, serviceKey);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      isAdminEntry = true;
    } else {
      const accessToken = body.access_token;
      if (!accessToken) {
        return res.status(401).json({ error: 'Please sign in to list a property' });
      }
      const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!userResp.ok) {
        return res.status(401).json({ error: 'Your session has expired — please sign in again' });
      }
      user = await userResp.json();
    }

    const validated = validateProperty(body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    // Admin entries use the service role key (bypasses RLS entirely, since we've
    // already independently verified this is a legitimate admin action above).
    // Normal user entries keep using the anon key exactly as before.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const insertHeaders = isAdminEntry
      ? { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Prefer': 'return=minimal' }
      : { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`, 'Prefer': 'return=minimal' };

    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties`, {
      method: 'POST',
      headers: insertHeaders,
      body: JSON.stringify({
        ...validated.data,
        user_id: user ? user.id : null,
        status: isAdminEntry ? 'approved' : 'pending'
      })
    });
    if (!response.ok) { const err = await response.text(); return res.status(400).json({ error: err }); }

    // Best-effort: tag this user's profile as a landlord now that they've actually
    // listed a property. Self-declared, not a security boundary (see submit-property
    // review notes) — purely so role data reflects reality for future features
    // (agent bulk tools, role-based analytics, etc). Never let this fail the submission.
    if (user) {
      try {
        await tagAsLandlordIfNeeded(user.id);
      } catch (e) {
        console.error('submit-property: role auto-tag failed:', e.message);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    await logError('submit-property', error);
    return res.status(500).json({ error: error.message });
  }
}

async function tagAsLandlordIfNeeded(userId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const profResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role`,
    { headers }
  );
  if (!profResp.ok) return;
  const rows = await profResp.json();
  const currentRole = rows[0]?.role;

  // Don't downgrade an existing agent, and don't bother re-writing if already landlord.
  if (currentRole === 'landlord' || currentRole === 'agent') return;

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ role: 'landlord' }),
  });
}
