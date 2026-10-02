'use strict';
const Lease = (typeof module !== 'undefined' && module.exports ? require('../shared/lease.js') : LeaseCore).configure({"EXPIRY":15000,"HEARTBEAT":5000,"RENEW_THROTTLE":2000});
if (typeof module !== 'undefined' && module.exports) module.exports = Lease;
