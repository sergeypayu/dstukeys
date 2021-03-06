var jk = require('jkurwa'),
    Curve = jk.Curve,
    b64_encode = jk.b64_encode,
    dstu = require('./dstu.js');

var Keyholder = function(cb) {
    var ob, keycoder, certs,
        have, signer, pem, mini,
        ready_sign, have_local, save_cert,
        save_key,
        pub_compressed, cert_lookup;

    keycoder = new jk.Keycoder();
    certs = {};
    is_ready_sign = function() {
        return (
                (ob.key !== undefined) &&
                (ob.cert !== undefined) &&
                ob.cert_key_match(ob.key, ob.cert)
        )
    };
    pub_compressed = function(p) {
        var key_priv = p;
        var key_pub = key_priv.pub();
        var point_cmp = key_pub.point.compress();

        return point_cmp.toString(16);
    };
    cert_key_match = function(key, cert) {
        var key_priv = key;
        var key_pub = key_priv.pub();
        var key_pub_compressed = key_pub.point.compress(key);

        return cert.pubkey.equals(key_pub_compressed);
    };
    have_password = function(decoded) {
        if ((decoded === undefined) ||
            (keycoder.is_valid(decoded) !== true)) {
            cb.feedback({password: false});
            cb.need({password: true});
            return;
        }

        cb.feedback({password: true});
        ob.raw_key = decoded;
        have({key: decoded})
    };
    have_key = function(data) {
        data = keycoder.maybe_pem(data);

        try {
            var parsed = keycoder.parse(data);
        } catch(e) {
            cb.feedback({key: false});
            return;
        }

        ob.key_info.format = parsed.format;

        switch(parsed.format) {
        case 'privkeys':
            ob.raw_key = data;
            ob.keystore = parsed;
            cb.feedback({key: true});

            if(ob.cert === undefined) {
                var key = parsed.keys[0]; // select first

                if(ob.cert_lookup(ob.pub_compressed(key))) {
                    ob.key = key;
                    cb.feedback({cert: true});
                } else {
                    cb.need({cert: true});
                }
            } else {
                var idx, key, point_str;
                for(idx = 0; idx < parsed.keys.length; idx++) {
                    key = parsed.keys[idx];
                    if(ob.cert.pubkey.toString(16) == ob.pub_compressed(key)) {
                        ob.key = key;
                        cb.feedback({cert: true});
                        break;
                    }
                }
                if(ob.key === undefined) {
                    cb.need({cert: true});
                }
            }
            break;
        case 'IIT':
        case 'PBES2':
            ob.raw_encrypted_key = data;
            ob.encrypted_key = parsed;
            cb.feedback({crypted_key: true})
            cb.need({password: true});
            break;
        case 'x509':
            ob.cert = parsed;
            ob.raw_cert = data;
            cb.feedback({cert: true});
            break;
        default:
            console.log("have something unknown");
        }

    };
    cert_lookup = function(pub_point) {
        var cert = certs[pub_point];
        if(cert === undefined) {
            return false;
        }
        ob.cert = cert.cert;
        ob.raw_cert = cert.raw_cert;

        return true;
    };
    have = function (data) {
        if (data.key !== undefined) {
            have_key(data.key);
        }
        if ((data.password !== undefined) && (ob.encrypted_key !== undefined)) {
            dstu.decode_data(ob.encrypted_key, data.password, have_password);
        }
    };
    signer = function(p) {
        return p || ob.key;
    };
    mini = function(do_raw) {
        var ret = '', raw='', bytes, i;
        bytes = ob.key.param_d.toByteArray();

        for(i=0; i<bytes.length; i++) {
            if(bytes[i] < 0) {
                bytes[i] = 255 + bytes[i];
            }
        }
        raw = 'R' + b64_encode(bytes);

        if(do_raw === true) {
            ret = raw;
        }

        return ret;
    };
    pem = function(what) {
        var ret = '';
        if(what === undefined) {
            what = {key: true};
        }

        if(what.key === true) {
            ret = keycoder.to_pem(b64_encode(ob.raw_encrypted_key, 42));
            ret += '\n';
        }

        if(what.raw_key === true) {
            ret = keycoder.to_pem(b64_encode(ob.raw_key, 42));
            ret += '\n';
        }

        if(what.cert === true) {
            ret = keycoder.to_pem(b64_encode(ob.raw_cert, 42), 'CERTIFICATE');
            ret += '\n';
        }

        return ret;
    };
    have_local = function() {
        var store = window.localStorage;
        var ret = [];
        var keys;
        var i;
        var idx;
        var data;
        var der;
        var cert;
        var key;
        var compressed;

        if(store === undefined) {
            return ret;
        }

        keys = Object.keys(store);
        for(i=0; i<keys.length; i++) {
            idx = keys[i];
            data = store[idx];
            if(idx.indexOf('cert-') === 0) {
                try {
                    der = keycoder.maybe_pem(data);
                    cert = keycoder.parse(der);
                    if(cert.format !== 'x509') {
                        throw new Error("expected cert");
                    }
                } catch(e) {
                    continue;
                }
                certs[cert.pubkey.toString(16)] = {
                    cert: cert,
                    raw_cert: der,
                    idx: idx,
                    have_key: false,
                }
            }
        }
        keys = Object.keys(store);
        for(i=0; i<keys.length; i++) {
            idx = keys[i];
            data = store[idx];
            if(idx.indexOf('key-') === 0) {
                try {
                    der = keycoder.maybe_pem(data);
                    key = keycoder.parse(der);
                    switch(key.format) {
                    case 'IIT':
                    case 'PBES2':
                        break;
                    default:
                        throw new Error("expected compressed key");
                    }
                } catch(e) {
                    continue;
                }

                compressed = idx.substr(4); // string after key- is compressed pub
                if(certs[compressed] !== undefined) {
                    certs[compressed]['have_key'] = true;
                    certs[compressed]['raw_key'] = der;
                }
            }
        }

        keys = Object.keys(certs);
        for(i=0; i<keys.length; i++) {
            ret.push(certs[keys[i]]);
        }

        return ret;
    };

    save_cert = function() {
        var data = ob.get_pem({cert: true});
        var serial = ob.cert.subject.serialNumber;

        var store = window.localStorage;
        if(store === undefined) {
            return;
        }

        store['cert-' + serial] = data;
    };

    save_key = function() {
        var data = ob.get_pem({key: true});
        var compressed = ob.pub_compressed(ob.key);

        var store = window.localStorage;
        if(store === undefined) {
            return;
        }

        store['key-' + compressed] = data;
    };

    ob = {
        have: have,
        get_pem: pem,
        get_mini: mini,
        get_signer: signer,
        is_ready_sign: is_ready_sign,
        cert_key_match: cert_key_match,
        pub_compressed: pub_compressed,
        cert_lookup: cert_lookup,
        have_local: have_local,
        save_cert: save_cert,
        save_key: save_key,
        key_info: {
        }
    };
    return ob;
};

module.exports = Keyholder;
