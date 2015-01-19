"use strict";

var API = require('cb-blockr')
var bitcoin = require('bitcoinjs-lib')
var TxGraph = require('bitcoin-tx-graph')
var assert = require('assert')
var discoverAddresses = require('./network').discoverAddresses
var fetchTransactions = require('./network').fetchTransactions
var validate = require('./validator')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var DEFAULT_GAP_LIMIT = 10

/**
 *  @param {string|HDNode}   options.externalAccount
 *  @param {string|HDNode}   options.internalAccount
 *  @param {string}          options.networkName
 *  @param {int} (optional)  options.gapLimit
 *  @param {function}        done
 */
function Wallet(options, done) {
  EventEmitter.call(this)

  if (arguments.length === 0) return this

  this.accounts = {}

  try {
    if(typeof options.externalAccount === 'string') {
      this.accounts.external = bitcoin.HDNode.fromBase58(options.externalAccount)
    } else {
      this.accounts.external = options.externalAccount
    }

    if(typeof options.internalAccount === 'string') {
      this.accounts.internal = bitcoin.HDNode.fromBase58(options.internalAccount)
    } else {
      this.accounts.internal = options.internalAccount
    }

    assert(this.accounts.external != null, 'externalAccount cannot be null')
    assert(this.accounts.internal != null, 'internalAccount cannot be null')
  } catch(e) {
    return done(e)
  }

  this.gapLimit = options.gapLimit || DEFAULT_GAP_LIMIT
  this.networkName = options.networkName
  this.api = new API(this.networkName)
  this.txGraph = new TxGraph()
  this.txMetadata = {}

  this.addresses = {
    internal: [], // change addresses
    external: []
  }

  this.bootstrap(done)
}

inherits(Wallet, EventEmitter)

Wallet.prototype.bootstrap = function(callback) {
  var that = this

  this.discoverAddresses(this.gapLimit, function(err) {
    if (err) return callback(err)

    that.fetchTransactions(0, callback)
  })
}

Wallet.prototype.discoverAddresses = function(gapLimit, callback) {
  var that = this
  if (typeof gapLimit === 'function') callback = gapLimit

  gapLimit = typeof gapLimit === 'number' ? gapLimit : this.gapLimit
  discoverAddresses(this.api, this.accounts.external, this.accounts.internal, gapLimit, function(err, addresses, changeAddresses) {
    if (err) return callback(err)

    that.addresses.external = addresses
    that.addresses.internal = changeAddresses

    callback(null, addresses.length + changeAddresses.length)
  })
}

Wallet.prototype.fetchTransactions = function(blockHeight, callback) {
  var that = this
  var addresses = this.getAllAddresses()
  var numUpdates = 0

  if (!addresses.length) return process.nextTick(callback);

  if (typeof blockHeight === 'function') callback = blockHeight

  blockHeight = typeof blockHeight === 'number' ? blockHeight : 0

  fetchTransactions(this.api, addresses, blockHeight, function(err, txs, metadata) {
    if (err) return callback(err);

    txs.forEach(function(tx) { that.addToGraph(tx) })

    var feesAndValues = that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])
    metadata = mergeMetadata(feesAndValues, metadata)

    for (var id in metadata) {
      try {
        // TODO: use deep equal instead of abusing assert
        assert.deepEqual(that.txMetadata[id], metadata[id])
      } catch (err) {
        that.txMetadata[id] = metadata[id]
        that.emit('transaction:update', that.txGraph.findNodeById(id).tx)
        numUpdates++
      }
    }

    callback(null, numUpdates)
  })
}

Wallet.prototype.addToGraph = function(tx, silent) {
  if (this.txGraph.addTx(tx) && !silent) this.emit('transaction:new', tx)
}

Wallet.prototype.sync = function(callback) {
  if (!this.getAllAddresses().length)
    this.bootstrap(callback)
  else
    this.fetchTransactions(this.getBlockHeight(), callback)
}

/**
 *  Returns the block height below which all transactions in the wallet 
 *  are confirmed to at least [confirmations] confirmations
 */
Wallet.prototype.getBlockHeight = function(confirmations) {
  var metadata = this.txMetadata;
  var safeHeight = Infinity;
  var top = 0;

  for (var id in metadata) {
    var txMetadata = metadata[id];
    if (!('blockHeight' in txMetadata)) continue;

    if (txMetadata.confirmations < confirmations) {
      safeHeight = Math.min(safeHeight, txMetadata.blockHeight);
    }

    top = Math.max(top, txMetadata.blockHeight);
  }

  if (safeHeight === Infinity)
    return top;

  return safeHeight;
}

Wallet.prototype.getAddresses = function(internal) {
  return this.addresses[internal ? 'internal' : 'external'];
 }

Wallet.prototype.getAllAddresses = function() {
  return (this.addresses.external || []).concat(this.addresses.internal || [])
}

Wallet.prototype.getBalance = function(minConf) {
  minConf = minConf || 0

  var utxos = this.getUnspents(minConf)

  return utxos.reduce(function(balance, unspent) {
    return balance + unspent.value
  }, 0)
}

Wallet.prototype.getNextAddress = function(account, offset) {
  if (typeof account === 'undefined' || typeof account === 'number') {
    offset = account
    account = null
  }

  account = account || this.accounts.external;
  var type = account === this.accounts.external ? 'external' : 'internal';
  var addresses = this.addresses[type];
  return account.derive(addresses.length + (offset || 0)).getAddress().toString()
}

Wallet.prototype.getNextChangeAddress = function(offset) {
  return this.getNextAddress(this.accounts.internal, offset);
}

/**
 *  {string|Address} address
 *  @return true if address is change address, false if address is not, undefined if we were unable to figure it out
 *    up to the gap limit
 */
Wallet.prototype.isChangeAddress = function(address) {
  var addrStr = address.toBase58Check ? address.toString() : address

  if (this.addresses.internal.indexOf(addrStr) !== -1) return true;
  if (this.addresses.external.indexOf(addrStr) !== -1) return false;

  if (getAddressIndex(addrStr, this.accounts.internal, this.addresses.internal.length, this.gapLimit) !== -1) return true
  if (getAddressIndex(addrStr, this.accounts.external, this.addresses.external.length, this.gapLimit) !== -1) return false
}

function getAddressIndex(address, account, startIndex, gapLimit) {
  for (var i = 0; i < gapLimit; i++) {
    var idx = startIndex + i
    var accountAddr = account.derive(idx).getAddress().toString()
    if (accountAddr === address) return idx
  }

  return -1
}

Wallet.prototype.getReceiveAddress = function() { 
  return this.addresses.external[this.addresses.external.length] || this.getNextAddress()
}

Wallet.prototype.getHDNodeForAddress = function(address) {
  var self = this
  var hdNode
  ;['internal', 'external'].some(function(accountType) {
    var idx = self.addresses[accountType].indexOf(address)
    if (idx === -1) 
      idx = getAddressIndex(address, self.accounts[accountType], self.addresses[accountType].length, self.gapLimit)
    
    if (idx !== -1) return hdNode = self.accounts[accountType].derive(idx);
  })

  return hdNode
}

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  var hdNode = this.getHDNodeForAddress(address)
  return hdNode && hdNode.privKey
}

Wallet.prototype.getPublicKeyForAddress = function(address) {
  var key = this.getPrivateKeyForAddress(address)
  return key && key.pub
}

/**
 * Check if any of these transactions are to this wallet, and update the used address caches
 * 
 *  @param {Transaction|Transaction Array} txs
 */
Wallet.prototype.updateAddresses = function(txs) {
  var self = this;

  if (!Array.isArray(txs)) txs = [txs]

  var txAddrs = []
  for (var i = 0; i < txs.length; i++) {
    var tx = txs[i] 
    tx = tx.tx || tx
    for (var j = 0; j < tx.outs.length; j++) {
      var out = tx.outs[j];
      if (!bitcoin.scripts.isNullDataOutput(out.script)) {
        var address = bitcoin.Address.fromOutputScript(out.script, bitcoin.networks[this.networkName]).toString()
        txAddrs.push(address)
      }
    }
  }

  ;['internal', 'external'].forEach(function(accountType) {
    var account = self.accounts[accountType]
    var myAddrs = self.addresses[accountType]
    var myNewAddrs = []
    var skipped = 0

    while (skipped < self.gapLimit && txAddrs.length) {
      var myAddr = self.getNextAddress(account, skipped)
      myNewAddrs.push(myAddr)

      var idx = txAddrs.indexOf(myAddr)
      if (idx === -1) {
        skipped++
        continue
      }

      self.emit('usedaddress', myAddr)
      txAddrs.splice(idx, 1);
      myAddrs.push.apply(myAddrs, myNewAddrs)
      skipped = 0
    }
  });
}

// param: `txObj` or
// `[{tx: txObj1, confirmations: n1, timestamp: t1}, {tx: txObj2, confirmations: n2, timestamp: t2}]`
Wallet.prototype.processTx = function(txs) {
  if(!Array.isArray(txs)) {
    txs = [{tx: txs}]
  }

  // check txs against wallet's addresses, generatinga new addresses until we reach the gap limit

  this.updateAddresses(txs)

  txs.forEach(function(obj) {
    var tx = obj.tx
    this.addToGraph(tx)

    var id = tx.getId()
    this.txMetadata[id] = this.txMetadata[id] || { confirmations: null }
    if(obj.confirmations != null) {
      this.txMetadata[id].confirmations = obj.confirmations
    }
    if(obj.timestamp != null) {
      this.txMetadata[id].timestamp = obj.timestamp
    }
  }, this)

  //FIXME: make me more effecient
  var myAddresses = this.getAllAddresses()
  var feesAndValues = this.txGraph.calculateFeesAndValues(myAddresses, bitcoin.networks[this.networkName])
  this.txMetadata = mergeMetadata(feesAndValues, this.txMetadata)
}

Wallet.prototype.createTx = function(to, value, fee, minConf, data) {
  var network = bitcoin.networks[this.networkName]
  validate.preCreateTx(to, value, network)

  if (minConf == null) minConf = 1
  var utxos = this.getUnspents(minConf)
  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var accum = 0
  var subTotal = value
  var addresses = []

  var builder = new bitcoin.TransactionBuilder()
  builder.addOutput(to, value)

  var that = this
  utxos.some(function(unspent) {
    builder.addInput(unspent.id, unspent.index)
    addresses.push(unspent.address)

    var estimatedFee
    if(fee == undefined) {
      estimatedFee = estimateFeePadChangeOutput(builder.buildIncomplete(), network)
    } else {
      estimatedFee = fee
    }

    accum += unspent.value
    subTotal = value + estimatedFee
    if (accum >= subTotal) {
      var change = accum - subTotal

      if (change > network.dustThreshold) {
        builder.addOutput(that.getNextChangeAddress(), change)
      }

      return true
    }
  })

  validate.postCreateTx(subTotal, accum, this.getBalance(minConf))

  if (data) builder.addOutput(bitcoin.scripts.nullDataOutput(data), 0)

  addresses.forEach(function(address, i) {
    builder.sign(i, that.getPrivateKeyForAddress(address))
  })

  return builder.build()
}

Wallet.prototype.sendTx = function(tx, done) {
  var that = this
  this.api.transactions.propagate(tx.toHex(), function(err){
    if(err) return done(err);

    that.processTx(tx)
    done()
  })
}

/**
 *  @param {string|Transaction} tx or id
 */
Wallet.prototype.getMetadata = function(tx) {
  var txId = tx.txId ? tx.txId() : tx;
  return this.txMetadata[txId];
}

Wallet.prototype.getUnspents = function(minConf) {
  var network = bitcoin.networks[this.networkName]
  var myAddresses = this.getAllAddresses();
  var metadata = this.txMetadata;
  var confirmedNodes = this.txGraph.getAllNodes().filter(function(n) {
    var meta = metadata[n.id]
    return meta && meta.confirmations >= minConf
  });

  return confirmedNodes.reduce(function(unspentOutputs, node) {
    node.tx.outs.forEach(function(out, i) {
      if (bitcoin.scripts.isNullDataOutput(out.script)) return;

      var address = bitcoin.Address.fromOutputScript(out.script, network).toString()
      if(myAddresses.indexOf(address) >= 0 && node.nextNodes[i] == null) {
        unspentOutputs.push({
          id: node.id,
          address: address,
          value: out.value,
          index: i
        })
      }
    })

    return unspentOutputs
  }, [])
}

function estimateFeePadChangeOutput(tx, network) {
  var tmpTx = tx.clone()
  var tmpAddress = bitcoin.Address.fromOutputScript(tx.outs[0].script, network)
  tmpTx.addOutput(tmpAddress, network.dustSoftThreshold || 0)

  return network.estimateFee(tmpTx)
}

Wallet.prototype.getTransactionHistory = function() {
  var txGraph = this.txGraph
  var metadata = this.txMetadata

  var nodes = txGraph.getAllNodes().filter(function(n) {
    return n.tx != null && metadata[n.id].value != null
  }).sort(function(a, b) {
    var confDiff = metadata[a.id].confirmations - metadata[b.id].confirmations
    if(confDiff !== 0) {
      return confDiff
    }

    return txGraph.compareNodes(a, b)
  })

  return nodes.map(function(n) {
    return n.tx
  })
}

Wallet.prototype.serialize = function() {
  var txs = this.txGraph.getAllNodes().reduce(function(memo, node) {
    var tx = node.tx
    if(tx == null) return memo;

    memo.push(tx.toHex())
    return memo
  }, [])

  return JSON.stringify({
    accounts: {
      external: this.accounts.external.toBase58(),
      internal: this.accounts.internal.toBase58()
    },
    addresses: this.addresses,
    networkName: this.networkName,
    txs: txs,
    txMetadata: this.txMetadata,
    gapLimit: this.gapLimit
  })
}

Wallet.deserialize = function(json) {
  var wallet = new Wallet()
  var deserialized = JSON.parse(json)
  wallet.gapLimit = deserialized.gapLimit || DEFAULT_GAP_LIMIT;
  wallet.accounts = {}
  wallet.addresses = {}  
  ;['internal', 'external'].forEach(function(accountType) {
    wallet.accounts[accountType] = bitcoin.HDNode.fromBase58(deserialized.accounts[accountType])
    wallet.addresses[accountType] = deriveAddresses(wallet.accounts[accountType], deserialized.addresses[accountType].length)
  })

  wallet.networkName = deserialized.networkName
  wallet.api = new API(deserialized.networkName)
  wallet.txMetadata = deserialized.txMetadata

  wallet.txGraph = new TxGraph()
  deserialized.txs.forEach(function(hex) {
    wallet.addToGraph(bitcoin.Transaction.fromHex(hex), true) // silent add
  })

  return wallet
}


function mergeMetadata(feesAndValues, metadata) {
  for(var id in metadata) {
    var fee = feesAndValues[id].fee
    if(fee != null) metadata[id].fee = fee

    var value = feesAndValues[id].value
    if(value < 0) value += fee
    if(value != null) metadata[id].value = value
  }

  return metadata
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

module.exports = Wallet

