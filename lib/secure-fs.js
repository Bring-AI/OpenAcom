'use strict';
// chmod() does not touch the Windows security descriptor, so the historical
// `if (process.platform !== 'win32') chmod(0o700)` pattern silently meant
// "keep inheriting whatever my parent directory grants" - on a shared machine
// that can include other interactive users. Real tightening on Windows goes
// through icacls, and when that cannot be done the artifact itself has to say
// so instead of pretending (see INHERITED).
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PRIVATE = 'private';
const INHERITED = 'inherited';

// Explicit operator override wins, because account-name resolution is not
// something this module can verify from here.
const PRINCIPAL_ENV = ['OPENACOM_ACL_PRINCIPAL', 'AGENTRELAY_ACL_PRINCIPAL'];

function currentPrincipal() {
  for (const key of PRINCIPAL_ENV) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  let name = '';
  try { name = String(os.userInfo().username || '').trim(); } catch { name = ''; }
  if (!name) name = String(process.env.USERNAME || process.env.USER || process.env.LOGNAME || '').trim();
  if (!name) return '';
  const domain = String(process.env.USERDOMAIN || '').trim();
  // A bare name is looked up locally only. On a domain or Microsoft-account
  // workstation the principal that owns the token is DOMAIN\name.
  if (domain && !name.includes('\\') && !name.includes('@')) return `${domain}\\${name}`;
  return name;
}

function grant(directory) {
  // (OI)(CI) so files and sub-directories created later stay with the same user.
  return directory ? '(OI)(CI)F' : 'F';
}

// Returns { acl, path, platform, principal, error? }. Never throws: a caller
// that cannot act on the marker still must not lose the credential it wrote.
function protectPath(absolutePath, {
  directory = false,
  platform = process.platform,
  spawn = spawnSync,
  chmod = (target, mode) => fs.chmodSync(target, mode),
  stat = (target) => fs.statSync(target),
  principal = currentPrincipal(),
} = {}) {
  const shape = { path: absolutePath, platform, principal };
  const degraded = (message) => {
    process.stderr.write(`OpenAcom secure-fs: ${message}\n`);
    return Object.assign(shape, { acl: INHERITED, error: message });
  };
  if (typeof absolutePath !== 'string' || !absolutePath) {
    return degraded('protectPath needs a non-empty path');
  }
  if (platform !== 'win32') {
    const mode = directory ? 0o700 : 0o600;
    try { chmod(absolutePath, mode); } catch (error) {
      return degraded(`chmod 0${mode.toString(8)} on ${absolutePath} failed: ${error.message}`);
    }
    let actual;
    try { actual = stat(absolutePath); } catch (error) {
      return degraded(`cannot verify ${absolutePath} after chmod: ${error.message}`);
    }
    if ((actual.mode & 0o077) !== 0) {
      return degraded(`${absolutePath} is still 0${(actual.mode & 0o777).toString(8)} after chmod 0${mode.toString(8)}; group or other keep access (unsupported filesystem?)`);
    }
    return Object.assign(shape, { acl: PRIVATE });
  }
  if (!principal) {
    return degraded(`cannot resolve the current Windows account for ${absolutePath}; set OPENACOM_ACL_PRINCIPAL to the principal that must keep access`);
  }
  // argv array, never a joined command line: paths and account names with
  // spaces or metacharacters must not reach a shell.
  const argv = [absolutePath, '/inheritance:r', '/grant:r', `${principal}:${grant(directory)}`];
  let result;
  try { result = spawn('icacls', argv, { encoding: 'utf8', windowsHide: true, shell: false }); } catch (error) {
    return degraded(`icacls for ${absolutePath} could not start: ${error.message}`);
  }
  if (!result || result.error) {
    return degraded(`icacls for ${absolutePath} could not start: ${(result && result.error.message) || 'no result'}`);
  }
  if (result.status !== 0) {
    return degraded(`icacls for ${absolutePath} exited ${result.status}: ${String(result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  }
  return Object.assign(shape, { acl: PRIVATE });
}

// One marker for a set of protected paths, so a descriptor can state that at
// least one of its files kept inherited access.
function aggregateAcl(results) {
  return results.every((result) => result && result.acl === PRIVATE) ? PRIVATE : INHERITED;
}

module.exports = { protectPath, aggregateAcl, currentPrincipal, PRIVATE, INHERITED };
