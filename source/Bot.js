const EventEmitter = require('events').EventEmitter;
const Inventory = require('./Inventory.js');
const request = require('request');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

const Bot = module.exports = {
  async init(config) {
    this.config = config;
    ({emit, proxy, trackedInventories} = config);

    this.proxy = proxy;
    this.trackedInventories = trackedInventories;
    this.label = `[${config.steamid}]`;
    this.openTrades = {};
    this.confirmationRetries = {};
    this.log = [];
    this.inventory = Object.create(Inventory);
  },
  async startTracking() {
    this.emit('info', `Starting tracking`);
    this.inventory.init(this.trackedInventories, this.config.steamid, null /*, 1000*/);
    this.items = this.inventory.inventory;
    this.inventory.on('info', info => {
      this.emit('info', `${info}`);
    });
    this.inventory.on('err', (msg, err) => {
      this.emit('err', `${msg}`, err);
    });
    try {
      await this.inventory.startTracking();
      this.emit('info', `\n${JSON.stringify(this.trackedInventories, null, 4)}\nNow being tracked`);
    } catch(err) {
      this.emit('err', `Error tracking inventory`, err);
    }
  },
  async start() {
    const r = request.defaults({
      proxy: this.proxy
    });
    this.community = new SteamCommunity({
      request: r
    });
    this.manager = new TradeOfferManager({
      community: this.community,
      pollInterval: 5000,
      globalAssetCache: true,
      cancelTime: this.config.cancelTime,
      pollData: this.config.pollData
    });

    try {
      this.emit('info', `Logging into Steam ${this.proxy ? "with proxy: " + this.proxy : "" }`);
      const cookies = await this.login();
      this.emit('info', `Logged into Steam successfully`);
      await this.setCookies(cookies);
      this.community.on('debug', msg => {
        if (msg === 'Checking confirmations') return;
        this.emit('debug', `${msg}`);
      });
      //Called when Steam redirects us to the login page
      this.community.on('sessionExpired', this.retryLogin.bind(this));
      this.community.startConfirmationChecker(10000/*, this.config.identity*/);
      this.community.on('confKeyNeeded', (tag, callback) => {
        const time = SteamTotp.time();
        callback(null, time, SteamTotp.getConfirmationKey(this.config.identity, time, tag));
      });
      this.community.on('newConfirmation', this.newConfirmation.bind(this));
      this.manager.on('sentOfferChanged', this.sentOfferStateChange.bind(this));
    } catch(err) {
      this.emit('err', `Error starting bot`, err);
      //Retry?
    }
  },
  login() {
    const authCode = this.generateAuthCode();
    this.emit('debug', `2FA auth code ${authCode}`);
    return new Promise((resolve, reject) => {
      ({username, password} = this.config);
      this.community.login({
        accountName: username,
        password: password,
        twoFactorCode: authCode
      }, (err, session, cookies) => {
        if (err) return reject(err);
        resolve(cookies);
      });
    })
    .catch(err => {
      this.emit('err', `Error logging into Steam`, err);
      throw err;
    });
  },
  async retryLogin() {
    if (this.retryingLogin) return;
    this.retryingLogin = true;

    this.emit('info', `Logging into Steam`);
    for (let i = 0; i < 3; i++) {
      try {
        const cookies = await this.login();
        await this.setCookies(cookies);
        this.emit('info', `Logged into Steam successfully`);
        this.retryingLogin = false;
        return;
      } catch(err) {
        if (err.toString().includes('SteamGuardMobile'))
          this.emit('err', `${err.message}`);
        else
          this.emit('err', `Error logging into Steam`, err);
        await this.pause(30 * 1000);
      }
    }
    this.emit('err', `Unable to log into Steam. Waiting a minute before retrying`);
    await this.pause(60 * 1000);
    this.isRetryingLogin = false;
    this.retryLogin();
  },
  setCookies(cookies) {
    return new Promise((resolve, reject) => {
      this.manager.setCookies(cookies, null, err => {
        if (err) return reject(err);
        return resolve();
      });
    });
  },
  async newConfirmation(confirmation) {
    if (confirmation.type !== SteamCommunity.ConfirmationType.Trade) {
      this.emit('warning', `A non-trade confirmation was created`);
      try {
        await this.respondToConfirmation(confirmation, false);
      } catch(err) {
        this.emit('err', `Failed to cancel confirmation`, err.message);
      }
    }
    const tradeOfferId = confirmation.creator;
    try {
      await this.respondToConfirmation(confirmation, true);
      this.emit('info', `Accepted confirmation ${confirmation.id}`);
      this.emit('trade', tradeOfferId, 'confirm.confirmed');
    } catch(err) {
      if (err.message.toString().includes('Could not act on confirmation')) {
        if (!this.confirmationRetries[confirmation.id]) {
          this.confirmationRetries[confirmation.id] = 0;
        }
        if (this.confirmationRetries[confirmation.id] === 5) { 
          try {
            this.emit('trade', tradeOfferId, 'confirm.failed');
            const trade =  await this.getTrade(tradeOfferId);
            trade.decline();
            this.emit('info', `Retried too many times but failed to confirm trade. Cancelling offer.`);
            this.inventory.setKey(itemsToGive, 'inTrade', true);
          } catch(err) {
            this.emit('err', `Error declining trade after 5 confirmation retries`, err);
          }
        }
        //Will retry after next confirmation poll
        delete this.community._knownConfirmations[confirmation.id]; 
        this.confirmationRetries[confirmation.id]++;
      } else {
        delete this.community._knownConfirmations[confirmation.id]; 
      }
      return;
    }
  },
  getTrade(id) {
    return new Promise((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) return reject(err);
        resolve(offer);
      });
    });
  },
  respondToConfirmation(confirmation, accept) {
    const time = SteamTotp.time();
    const key = SteamTotp.getConfirmationKey(this.config.identity, time, 'allow');
    return new Promise((resolve, reject) => {
      confirmation.respond(time, key, accept, err => {
        if (err) return reject(err);
        resolve();
      });
    });
  },
  sendTrade(steamid, itemsToGive, itemsToReceive, token) {
    return new Promise((resolve, reject) => {
      const offer = this.manager.createOffer(steamid, token);
      const res = this.inventory.itemsAvailable(itemsToGive);
      if (res) {
        this.emit('err', `${res.items ? res.items.length : "Some"} items not tracked in bots inventory. Trade not sending`, res);
        return reject();
      }
      itemsToGive.forEach(item => offer.addMyItem(item));
      itemsToReceive.forEach(item => offer.addTheirItem(item));
      offer.send((err, status) => {
        if (err) return reject(err);
        resolve(offer.id);
        this.inventory.setKey(itemsToGive, 'inTrade', true);
        this.openTrades[offer.id] = new Date();
        this.emit('trade', offer.id, 'send.sent');
        setTimeout(this.checkOfferResolution.bind(this, offer.id), this.config.cancelTime);
      });
    });
  },
  async sentOfferStateChange(offer, oldState) {
    const stateEnum = this.manager.ETradeOfferState;
    const state = stateEnum[offer.state];
    this.emit(
      'info',
      `An offer has changed state from '${stateEnum[oldState]}' -> '${state}'`
    );

    if (!this.openTrades[offer.id]) {
      this.emit('info', `Unknown offer ${offer.id}`);
      //Must have been created manually, or lost over restart
    }

    if (
      offer.state === stateEnum.Active ||
      offer.state === stateEnum.CreatedNeedsConfirmation ||
      offer.state === stateEnum.Invalid
    ) return;

    if (
      offer.state === stateEnum.InEscrow ||
      offer.state === stateEnum.Countered
    ) {
      try {
        this.emit('info', `Cancelling offer ${offer.id} (state: ${state})`);
        await this.respondToOffer(offer, false);
        delete this.openTrades[offer.id];
        this.emit('trade', offer.id, 'offer.failed');
      } catch(err) {
        this.emit('err', `Error declining offer ${offer.id}`, err);
        checkOfferNextPoll(offer.id, oldState);
      }
      return;
    }

    if (offer.state !== stateEnum.Accepted) {
      //Items will no longer be exchanged
      this.inventory.setKey(offer.itemsToGive, 'inTrade', false);
      delete this.openTrades[offer.id];
      return;
    }

    //A state of 'Accepted' does not always mean items have been exchanged
    try {
      const exchangeDetails = await this.getExchangeDetails(offer);
    } catch(err) {
      this.emit('err', `Error getting exchange details ${offer.id}`, err);
      return checkOfferNextPoll(offer.id, oldState);
    }
    //Trade is Complete, InEscrow, or EscrowRollback
    const status = this.manager.ETradeStatus[exchangeDetails.status];
    //InEscrow or EscrowRollback trades have already been cancelled
    if (status !== 'Completed') {
      //Items have probably not been exchanged yet
      this.emit('warning', `Trade has been 'Accepted' but not 'Completed' ${offer.id}`);
      return checkOfferNextPoll(offer.id, oldState);
    }
    this.emit('trade', offer.id, 'offer.exchanged');
    this.inventory.removeItems(exchangeDetails.sentItems);
      
    try {
      const receivedItems = await this.getReceivedItems(offer);
      this.inventory.addItems(receivedItems);
      this.emit('info', `Offer ${offer.id} has been Completed and new items recorded`);
    } catch(err) {
      this.emit('err', `Error getting received items for ${offer.id}`);
      return checkOfferNextPoll(offer.id, oldState);
    }  
  },
  checkOfferNextPoll(offerId, oldState) {
    this.manager.pollData.sent[offerId] = oldState;
    this.manager.emit('pollData', this.manager.pollData);
  },
  getExchangeDetails(offer) {
    return new Promise((resolve, reject) => {
      offer.getReceivedItems((err, status, tradeInitTime, receivedItems, sentItems) => {
        if (err) return reject(err);
        resolve({
          status: status,
          tradeInitTime: tradeInitTime,
          receivedItems: receivedItems,
          sentItems: sentItems
        });
      })
    });
  },
  getReceivedItems(offer) {
    return new Promise((resolve, reject) => {
      offer.getReceivedItems((err, items) => {
        if (err) return reject(err);
        resolve(items);
      });
    })
  },
  checkOfferResolution(offerId) {
    this.emit('err', 'checkOfferResolution function not implemented');
  },
  respondToOffer(offer, res) {
    return new Promise((resolve, reject) => {
      if (res) offer.accept(cb);
      else offer.decline(cb);

      function cb(err, status) {
        if (err) return reject(err);
        delete this.openTrades[offer.id];
        resolve(status);
      }
    });
  },
  generateAuthCode() {
    return SteamTotp.generateAuthCode(this.config.shared);
  },
  pause(ms) {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }
};

Object.setPrototypeOf(Bot, EventEmitter.prototype);