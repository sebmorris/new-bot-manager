const EventEmitter = require('events').EventEmitter;
const Inventory = require('./Inventory.js');
const request = require('request');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

const Bot = {
  async init(config) {
    this.config = config;
    const { proxy, trackedInventories } = config;

    this.proxy = proxy;
    this.trackedInventories = trackedInventories;
    this.label = `[${config.steamid}]`;
    this.openTrades = {};
    this.confirmationRetries = {};
    this.log = [];
    this.inventory = Object.create(Inventory);
  },
  async start() {
    const r = request.defaults({
      proxy: this.proxy,
    });
    this.community = new SteamCommunity({
      request: r,
    });
    this.manager = new TradeOfferManager({
      community: this.community,
      pollInterval: 5000,
      globalAssetCache: true,
      cancelTime: this.config.cancelTime,
      pollData: this.config.pollData,
    });

    try {
      this.emit('info', `Logging into Steam ${this.proxy ? `with proxy: ${this.proxy}` : ''}`);
      const cookies = await this.login();
      this.emit('info', 'Logged into Steam successfully');
      await this.setCookies(cookies);
      this.community.on('debug', (msg) => {
        if (msg === 'Checking confirmations') return;
        this.emit('debug', `${msg}`);
      });
      // Called when Steam redirects us to the login page
      this.community.on('sessionExpired', this.retryLogin.bind(this));
      this.community.startConfirmationChecker(10000 /* , this.config.identity */);
      this.community.on('confKeyNeeded', (tag, callback) => {
        const time = SteamTotp.time();
        callback(null, time, SteamTotp.getConfirmationKey(this.config.identity, time, tag));
      });
      this.community.on('newConfirmation', this.newConfirmation.bind(this));
      this.manager.on('sentOfferChanged', this.sentOfferStateChange.bind(this));
    } catch (err) {
      this.emit('err', 'Error starting bot', err);
      // Retry?
    }
  },
  login() {
    const authCode = this.generateAuthCode();
    this.emit('debug', `2FA auth code ${authCode}`);
    return new Promise((resolve, reject) => {
      const { username, password } = this.config;
      this.community.login({
        password,
        accountName: username,
        twoFactorCode: authCode,
      }, (err, session, cookies) => {
        if (err) return reject(err);
        return resolve(cookies);
      });
    })
      .catch((err) => {
        this.emit('err', 'Error logging into Steam', err);
        throw new Error(`Error logging into Steam\n${err}`);
      });
  },
  async retryLogin() {
    if (this.retryingLogin) return;
    this.retryingLogin = true;
    this.notLoggedIn = true;

    this.emit('info', 'Logging into Steam');
    try {
      const cookies = await this.login();
      await this.setCookies(cookies);
      this.emit('info', 'Logged into Steam successfully');
      this.retryingLogin = false;
      return;
    } catch (err) {
      if (err.toString().includes('SteamGuardMobile')) this.emit('err', `${err.message}`);
      else this.emit('err', 'Error logging into Steam', err);
      await this.pause(30 * 1000);
    }
    this.emit('err', 'Unable to log into Steam. Waiting a minute before retrying');
    await this.pause(60 * 1000);
    this.isRetryingLogin = false;
    this.retryLogin();
  },
  setCookies(cookies) {
    return new Promise((resolve, reject) => {
      this.manager.setCookies(cookies, null, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  },
  generateAuthCode() {
    return SteamTotp.generateAuthCode(this.config.shared);
  },
  async startTracking(refreshInterval) {
    this.emit('info', 'Starting tracking');
    this.inventory.init(this.trackedInventories, this.config.steamid, null, refreshInterval);
    this.items = this.inventory.inventory;
    this.inventory.on('info', (info) => {
      this.emit('info', `${info}`);
    });
    this.inventory.on('err', (msg, err) => {
      this.emit('err', `${msg}`, err);
    });
    try {
      await this.inventory.startTracking();
      this.emit('info', `\n${JSON.stringify(this.trackedInventories, null, 4)}\nNow being tracked`);
    } catch (err) {
      this.emit('err', 'Error tracking inventory', err);
    }
  },
  async newConfirmation(confirmation) {
    if (confirmation.type !== SteamCommunity.ConfirmationType.Trade) {
      this.emit('warning', 'A non-trade confirmation was created');
      try {
        await this.respondToConfirmation(confirmation, false);
      } catch (err) {
        this.emit('err', 'Failed to cancel confirmation', err.message);
      }
    }
    const tradeOfferId = confirmation.creator;
    try {
      await this.respondToConfirmation(confirmation, true);
      this.emit('info', `Accepted confirmation ${confirmation.id}`);
      this.emit('trade', tradeOfferId, 'confirm.confirmed');
    } catch (confirmationErr) {
      if (confirmationErr.message.toString().includes('Could not act on confirmation')) {
        if (!this.confirmationRetries[confirmation.id]) {
          this.confirmationRetries[confirmation.id] = 0;
        }
        if (this.confirmationRetries[confirmation.id] === 5) {
          try {
            this.emit('trade', tradeOfferId, 'confirm.failed');
            const trade = await this.getTrade(tradeOfferId);
            trade.decline();
            this.emit('info', 'Retried too many times but failed to confirm trade. Cancelling offer.');
            this.inventory.setKey(trade.itemsToGive, 'inTrade', true);
          } catch (declineErr) {
            this.emit('err', 'Error declining trade after 5 confirmation retries', declineErr);
          }
        }
        // Will retry after next confirmation poll
        // eslint-disable-next-line no-underscore-dangle
        delete this.community._knownConfirmations[confirmation.id];
        this.confirmationRetries[confirmation.id] += 1;
      } else {
        // eslint-disable-next-line no-underscore-dangle
        delete this.community._knownConfirmations[confirmation.id];
      }
    }
  },
  getTrade(id) {
    return new Promise((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) return reject(err);
        return resolve(offer);
      });
    });
  },
  respondToConfirmation(confirmation, accept) {
    const time = SteamTotp.time();
    const key = SteamTotp.getConfirmationKey(this.config.identity, time, 'allow');
    return new Promise((resolve, reject) => {
      confirmation.respond(time, key, accept, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  },
  sendTrade(steamid, itemsToGive, itemsToReceive, token) {
    return new Promise((resolve, reject) => {
      const offer = this.manager.createOffer(steamid, token);
      const res = this.inventory.itemsAvailable(itemsToGive);
      if (res) {
        this.emit('err', `${res.items ? res.items.length : 'Some'} items not tracked in bots inventory. Trade not sending`, res);
        return reject();
      }
      itemsToGive.forEach(item => offer.addMyItem(item));
      itemsToReceive.forEach(item => offer.addTheirItem(item));
      return offer.send((err) => {
        if (err) return reject(err);
        this.inventory.setKey(itemsToGive, 'inTrade', true);
        this.addOpenTrade(offer.id);
        this.emit('trade', offer.id, 'send.sent');
        return resolve(offer.id);
      });
    });
  },
  async sentOfferStateChange(offer, oldState) {
    const stateEnum = this.manager.ETradeOfferState;
    const state = stateEnum[offer.state];
    this.emit(
      'info',
      `An offer has changed state from '${stateEnum[oldState]}' -> '${state}'`,
    );

    if (!this.openTrades[offer.id]) {
      this.emit('info', `Unknown offer ${offer.id}`);
      // Must have been created manually, or lost over restart
    }

    if (
      offer.state === stateEnum.InEscrow ||
      offer.state === stateEnum.Countered
    ) {
      // TODO: refactor this? Same in checkOfferResolution
      try {
        this.emit('info', `Cancelling offer ${offer.id} (state: ${state})`);
        await this.respondToOffer(offer, false);
        delete this.openTrades[offer.id];
        this.inventory.setKey(offer.itemsToGive, 'inTrade', false);
        this.emit('trade', offer.id, 'offer.failed');
      } catch (err) {
        this.emit('err', `Error declining offer ${offer.id}`, err);
        this.checkOfferNextPoll(offer.id, oldState);
      }
      return;
    }

    this.checkOfferResolution(offer)
      .then((res) => {
        this.emit('info', `Changed offer resolved: ${res}`);
      })
      .catch((err) => {
        // Consider checking offer again next poll?
        this.emit('err', `Error checking offer ${offer.id} resolution from 'sentOfferChanged'`, err);
      });
  },
  checkOfferNextPoll(offerId, oldState) {
    this.manager.pollData.sent[offerId] = oldState;
    this.manager.emit('pollData', this.manager.pollData);
  },
  getExchangeDetails(offer) {
    return new Promise((resolve, reject) => {
      offer.getReceivedItems((err, status, tradeInitTime, receivedItems, sentItems) => {
        if (err) return reject(err);
        return resolve({
          status,
          tradeInitTime,
          receivedItems,
          sentItems,
        });
      });
    });
  },
  getReceivedItems(offer) {
    return new Promise((resolve, reject) => {
      offer.getReceivedItems((err, items) => {
        if (err) return reject(err);
        return resolve(items);
      });
    });
  },
  async checkOfferResolution(offerId, retries = 0) {
    // TODO: separate retries. Maintain currently checking resolution
    this.emit('err', 'checkOfferResolution function not fully implemented');
    let offer;
    try {
      if (offerId.id) {
        offer = offerId;
        // eslint-disable-next-line no-param-reassign
        offerId = offer.id;
      } else {
        offer = await this.getTrade(offerId);
      }
    } catch (err) {
      const msg = `Could not get offer ${offerId} to check its resolution`;
      this.emit('err', msg);
      throw new Error(msg);
    }

    const stateEnum = this.manager.ETradeOfferState;
    const state = stateEnum[offer.state];

    if (
      offer.state === stateEnum.Active ||
      offer.state === stateEnum.CreatedNeedsConfirmation ||
      offer.state === stateEnum.Invalid
    ) {
      this.addOpenTrade(offerId);
      return `Offer could still be accepted (state: ${stateEnum[offer.state]}`;
    }

    if (state === 'CreatedNeedsConfirmation') {
      this.addOpenTrade(offerId);
      return 'Offer not confirmed, adding to openTrades';
    }

    if (state !== 'Accepted') {
      // Items will no longer be exchanged
      this.inventory.setKey(offer.itemsToGive, 'inTrade', false);
      delete this.openTrades[offer.id];
      this.emit('trade', offerId, 'offer.failed');
      return 'Offer items will no longer be exchanged, processing as such';
    }
    let exchangeDetails;
    try {
      exchangeDetails = await this.getExchangeDetails(true, offer);
    } catch (err) {
      this.emit('err', `Error getting exchange details, while checking offer resolution ${offer.id}`, err);
      if (retries === 5) {
        throw new Error(`Exchange details could not be retrieved ${offer.id}`);
      } else {
        return this.pause(1000 * 10)
          .then(() => this.checkOfferResolution(offer.id, retries + 1));
      }
    }

    const status = this.manager.ETradeStatus[exchangeDetails.status];

    if (status === 'Failed') {
      // Trade has been completely rolled back
      this.inventory.setKey(offer.itemsToGive, 'inTrade', false);
      delete this.openTrades[offer.id];
      return `Trade ${offer.id} was accepted but 'Failed'. Being rolled back`;
    }

    if (
      status === 'PartialSupportRollback' ||
      status === 'FullSupportRollback' ||
      status === 'SupportRollback_Selective' ||
      status === 'RollbackAbandoned' ||
      status === 'EscrowRollback'
    ) {
      // TODO: specific appid, contextid
      this.emit('info', `Trade ${offer.id} was rolled back (${status}). Force refreshing inventory`);
      return this.inventory.forceRefresh()
        .then(() => {
          const msg = `Trade ${offer.id} was rolled back (${status}). Inventory has been force refreshed`;
          this.emit('info', msg);
          return msg;
        })
        .catch((err) => {
          this.emit('err', `Error refreshing inventory after ${offer.id} rollback`);
          throw err;
        });
    }

    if (
      status === 'RollbackFailed'
    ) {
      // Mid rollback?
      this.emit('info', `Trade ${offer.id} has exchangeDetail status 'RollbackFailed'. Retrying in 10 seconds`);
      return this.pause(1000 * 10)
        .then(() => this.checkOfferResolution(offer, retries + 1));
    }

    if (status === 'InEscrow') {
      // Cancel trade
      try {
        this.emit('info', `Cancelling offer ${offer.id} (state: ${state})`);
        await this.respondToOffer(offer, false);
        delete this.openTrades[offer.id];
        this.inventory.setKey(offer.itemsToGive, 'inTrade', false);
        this.emit('trade', offer.id, 'offer.failed');
      } catch (err) {
        // TODO: if retries...
        this.emit('err', `Error declining offer ${offer.id}`, err);
        return this.pause(1000 * 10)
          .then(() => this.checkOfferResolution(offer, retries + 1));
      }
      return `Cancelled offer ${offer.id} (state: ${state})`;
    }

    if (status !== 'Completed') {
      // Items have probably not been exchanged yet - states 'Init', 'PreCommitted' or 'Committed'
      this.emit('warning', `Trade has been 'Accepted' but is not yet 'Completed' ${offer.id} (status)`);
      if (retries === 5) {
        throw new Error(`Trade is 'Accepted' but not 'Completed' after 5 retries ${offer.id}`);
      } else {
        return this.pause(1000 * 10)
          .then(() => this.checkOfferResolution(offer, retries + 1));
      }
    }
    this.emit('trade', offer.id, 'offer.exchanged');
    this.inventory.removeItems(exchangeDetails.sentItems);

    return this.processReceivedItems(offer);
    // TODO: Refactor retry into a function and CHECK this function, implement into parent
  },
  respondToOffer(offer, res) {
    return new Promise((resolve, reject) => {
      function cb(err, status) {
        if (err) return reject(err);
        delete this.openTrades[offer.id];
        return resolve(status);
      }

      if (res) offer.accept(cb);
      else offer.decline(cb);
    });
  },
  async processReceivedItems(offer, retries = 0) {
    try {
      const receivedItems = await this.getReceivedItems(offer);
      this.inventory.addItems(receivedItems);
      this.emit('info', `Offer was ${offer.id} Completed and new items recorded`);
      return `Offer was ${offer.id} Completed and new items recorded`;
    } catch (err) {
      this.emit('err', `Could not check offer resolution. Error getting received items for ${offer.id}`);
      if (retries === 5) {
        throw new Error(`Could not get received items after 5 retries ${offer.id}`);
      } else {
        return this.pause(1000 * 10)
          .then(() => this.processReceivedItems(offer, retries + 1));
      }
    }
  },
  addOpenTrade(offerId) {
    if (!this.openTrades[offerId]) {
      this.openTrades[offerId] = new Date();
      setTimeout(
        this.checkOfferResolution(offerId),
        this.config.cancelTime + (10 * 1000),
      );
    }
  },
  pause(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

module.exports = Bot;

Object.setPrototypeOf(Bot, EventEmitter.prototype);
