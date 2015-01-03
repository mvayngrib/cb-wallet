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

function Wallet(externalAccount, internalAccount, networkName, done) {
  EventEmitter.call(this)

  if (arguments.length === 0) return this

  try {
    if(typeof externalAccount === 'string') {
      this.externalAccount = bitcoin.HDNode.fromBase58(externalAccount)
    } else {
      this.externalAccount = externalAccount
    }

    if(typeof internalAccount === 'string') {
      this.internalAccount = bitcoin.HDNode.fromBase58(internalAccount)
    } else {
      this.internalAccount = internalAccount
    }

    assert(this.externalAccount != null, 'externalAccount cannot be null')
    assert(this.internalAccount != null, 'internalAccount cannot be null')
  } catch(e) {
    return done(e)
  }

  this.networkName = networkName
  this.api = new API(networkName)
  this.txGraph = new TxGraph()

  this.addresses = [];
  this.changeAddresses = [];
  this.bootstrap(DEFAULT_GAP_LIMIT, done)
}

inherits(Wallet, EventEmitter)

Wallet.prototype.bootstrap = function(gapLimit, callback) {
  var that = this

  this.discoverAddresses(gapLimit, function(err) {
    if (err) return callback(err)

    that.fetchTransactions(0, callback)
  })
}

Wallet.prototype.discoverAddresses = function(gapLimit, callback) {
  var that = this

  discoverAddresses(this.api, this.externalAccount, this.internalAccount, gapLimit, function(err, addresses, changeAddresses) {
    if (err) return callback(err)

    that.addresses = addresses
    that.changeAddresses = changeAddresses

    callback(null, addresses.length + changeAddresses.length)
  })
}

Wallet.prototype.fetchTransactions = function(blockHeight, callback) {
  var that = this
  var addresses = this.getAllAddresses()

  if (!addresses.length) return process.nextTick(callback);

  if (typeof blockHeight === 'function') {
    callback = blockHeight
    blockHeight = 0
  }

  blockHeight = blockHeight || 0
  fetchTransactions(this.api, addresses, blockHeight, function(err, txs, metadata) {
    if (err) return callback(err);

    txs.forEach(function(tx) { that.txGraph.addTx(tx) })

    var feesAndValues = that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])
    that.txMetadata = that.txMetadata || {}
    metadata = mergeMetadata(feesAndValues, metadata)

    for (var id in metadata) {
      that.txMetadata[id] = metadata[id]
    }

    callback(null, txs.length)
  })
}

Wallet.prototype.sync = function(callback) {
  var blockHeight = this.getBlockHeight();
  if (!this.getAllAddresses().length)
    this.bootstrap(callback)
  else
    this.fetchTransactions(blockHeight, callback)
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
    if (txMetadata.confirmations < confirmations) {
      safeHeight = Math.min(safeHeight, txMetadata.blockHeight);
    }

    top = Math.max(top, txMetadata.blockHeight);
  }

  if (safeHeight === Infinity)
    return top;

  return safeHeight;
}

Wallet.prototype.getAllAddresses = function() {
  return (this.addresses || []).concat(this.changeAddresses || [])
}

Wallet.prototype.getBalance = function(minConf) {
  minConf = minConf || 0

  var utxos = this.getUnspents(minConf)

  return utxos.reduce(function(balance, unspent) {
    return balance + unspent.value
  }, 0)
}

Wallet.prototype.getNextChangeAddress = function() {
  var addr = this.internalAccount.derive(this.changeAddresses.length).getAddress().toString()
  this.changeAddresses[this.changeAddresses.length] = addr
  this.emit('address:new', addr)
  return addr
}

Wallet.prototype.getNextAddress = function() {
  var addr = this.externalAccount.derive(this.addresses.length).getAddress().toString()
  this.addresses[this.addresses.length] = addr
  this.emit('address:new', addr)
  return addr
}

Wallet.prototype.isChangeAddress = function(address) {
  var addrStr = address.toBase58Check ? address.toString() : address
  return this.changeAddresses.indexOf(addrStr) !== -1
}

Wallet.prototype.getReceiveAddress = function() { 
  return this.addresses[this.addresses.length] || this.getNextAddress()
}

Wallet.prototype.getHDNodeForAddress = function(address) {
  var index
  if ((index = this.addresses.indexOf(address)) > -1) {
    return this.externalAccount.derive(index)
  } else if((index = this.changeAddresses.indexOf(address)) > -1) {
    return this.internalAccount.derive(index)
  } else {
    throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.')
  }
}

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  return this.getHDNodeForAddress(address).privKey
}

Wallet.prototype.getPublicKeyForAddress = function(address) {
  return this.getPrivateKeyForAddress(address).pub
}

// param: `txObj` or
// `[{tx: txObj1, confirmations: n1, timestamp: t1}, {tx: txObj2, confirmations: n2, timestamp: t2}]`
Wallet.prototype.processTx = function(txs) {
  if(!Array.isArray(txs)) {
    txs = [{tx: txs}]
  }

  var foundUsed = true
  while(foundUsed) {
    foundUsed = addToAddresses.bind(this)(this.getNextAddress(), this.getNextChangeAddress())
  }

  txs.forEach(function(obj) {
    var tx = obj.tx
    this.txGraph.addTx(tx)

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
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var feesAndValues = this.txGraph.calculateFeesAndValues(myAddresses, bitcoin.networks[this.networkName])
  this.txMetadata = mergeMetadata(feesAndValues, this.txMetadata)
  this.emit('transaction:processed', txs.map(function(obj) { return obj.tx.getId() }))
  // var data = txs.filter(function(tx) { 
  //   return tx.outs.filter(function(out) {
  //     return bitcoin.scripts.isNullDataOutput(out.script)
  //   }) 
  // })
  // if (data) this.emit('transaction:data', data)

  function addToAddresses(nextAddress, nextChangeAddress) {
    for(var i=0; i<txs.length; i++) {
      var tx = txs[i].tx
      var found = tx.outs.some(function(out){
        if (bitcoin.scripts.isNullDataOutput(out.script)) return false;

        var address = bitcoin.Address.fromOutputScript(out.script, bitcoin.networks[this.networkName]).toString()
        if(nextChangeAddress === address) {
          this.changeAddresses.push(address)
          return true
        } else if(nextAddress === address) {
          this.addresses.push(address)
          return true
        }
      }, this)

      if(found) return true
    }
  }
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

Wallet.prototype.getUnspents = function(minConf) {
  var network = bitcoin.networks[this.networkName]
  var myAddresses = this.getAllAddresses();
  var metadata = this.txMetadata;
  var unspentNodes = this.txGraph.heads.filter(function(n) {
    return metadata[n.id].confirmations >= minConf
  })

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
    externalAccount: this.externalAccount.toBase58(),
    internalAccount: this.internalAccount.toBase58(),
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    txs: txs,
    txMetadata: this.txMetadata
  })
}

Wallet.deserialize = function(json) {
  var wallet = new Wallet()
  var deserialized = JSON.parse(json)
  wallet.externalAccount = bitcoin.HDNode.fromBase58(deserialized.externalAccount)
  wallet.internalAccount = bitcoin.HDNode.fromBase58(deserialized.internalAccount)
  wallet.addresses = deriveAddresses(wallet.externalAccount, deserialized.addressIndex)
  wallet.changeAddresses = deriveAddresses(wallet.internalAccount, deserialized.changeAddressIndex)
  wallet.networkName = deserialized.networkName
  wallet.api = new API(deserialized.networkName)
  wallet.txMetadata = deserialized.txMetadata

  wallet.txGraph = new TxGraph()
  deserialized.txs.forEach(function(hex) {
    wallet.txGraph.addTx(bitcoin.Transaction.fromHex(hex))
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

