
function TxBuilder() {
  this._to = {};
}

TxBuilder.prototype.to = function(addr, amount) {
  if (!this._to[addr]) this._to[addr] = 0;

  this._to[addr] += amount;
  return this;
}

TxBuilder.prototype.from = function(addr) {
  this._from = Array.isArray(addr) ? addr : [addr];
  return this;
}

TxBuilder.prototype.fee = function(fee) {
  this._fee = fee;
  return this;
}

TxBuilder.prototype.minConf = function(minConf) {
  this._minConf = minConf;
  return this;
}

TxBuilder.prototype.data = function(data) {
  this._data = data;
  return this;
}

TxBuilder.prototype.build = function() {
  return {
    from: this._from,
    to: this._to,
    fee: this._fee,
    minConf: typeof this._minConf === 'undefined' ? 1 : this._minConf,
    data: this._data
  }
}

module.exports = TxBuilder;
