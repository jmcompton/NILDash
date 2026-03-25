// server/store.js
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const DEALS_FILE    = path.join(DATA_DIR, 'deals.json');

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE))    write(USERS_FILE, {});
  if (!fs.existsSync(ATHLETES_FILE)) write(ATHLETES_FILE, {});
  if (!fs.existsSync(DEALS_FILE))    write(DEALS_FILE, {});
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// USERS
function getUser(id)          { return read(USERS_FILE)[id] || null; }
function getUserByEmail(email) {
  return Object.values(read(USERS_FILE)).find(u => u.email === email) || null;
}
function saveUser(id, data) {
  const users = read(USERS_FILE);
  users[id] = { ...users[id], ...data, updatedAt: new Date().toISOString() };
  write(USERS_FILE, users);
  return users[id];
}
function getAllUsers() { return read(USERS_FILE); }

// ATHLETES
function getAthlete(id)              { return read(ATHLETES_FILE)[id] || null; }
function getAthletesByAgent(agentId) {
  return Object.values(read(ATHLETES_FILE)).filter(a => a.agentId === agentId);
}
function saveAthlete(id, data) {
  const athletes = read(ATHLETES_FILE);
  athletes[id] = { ...athletes[id], ...data, updatedAt: new Date().toISOString() };
  write(ATHLETES_FILE, athletes);
  return athletes[id];
}
function deleteAthlete(id) {
  const athletes = read(ATHLETES_FILE);
  delete athletes[id];
  write(ATHLETES_FILE, athletes);
}

// DEALS
function getDeal(id)                  { return read(DEALS_FILE)[id] || null; }
function getDealsByAthlete(athleteId) {
  return Object.values(read(DEALS_FILE)).filter(d => d.athleteId === athleteId);
}
function getDealsByAgent(agentId) {
  const athletes = getAthletesByAgent(agentId).map(a => a.id);
  return Object.values(read(DEALS_FILE)).filter(d => athletes.includes(d.athleteId));
}
function saveDeal(id, data) {
  const deals = read(DEALS_FILE);
  deals[id] = { ...deals[id], ...data, updatedAt: new Date().toISOString() };
  write(DEALS_FILE, deals);
  return deals[id];
}
function deleteDeal(id) {
  const deals = read(DEALS_FILE);
  delete deals[id];
  write(DEALS_FILE, deals);
}

init();

module.exports = {
  getUser, getUserByEmail, saveUser, getAllUsers,
  getAthlete, getAthletesByAgent, saveAthlete, deleteAthlete,
  getDeal, getDealsByAthlete, getDealsByAgent, saveDeal, deleteDeal,
};
