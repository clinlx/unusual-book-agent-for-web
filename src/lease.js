'use strict';
const Lease = (typeof module !== 'undefined' && module.exports ? require('./shared/lease.js') : LeaseCore).configure({"EXPIRY":8000,"HEARTBEAT":2000,"RENEW_THROTTLE":750});
if (typeof module !== 'undefined' && module.exports) module.exports = Lease;
