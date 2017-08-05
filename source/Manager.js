const EventEmitter = require('events').EventEmitter;
const Bot = require('./Bot.js');
const InventoryAPI = require('steam-inventory-api');

const Manager = module.exports = {
  init(config) {
    this.config = config;
    this.bots = {};
  },
  async addBot(config) {
    this.emit('info', config.steamid, 'Adding bot');
    const bot = Object.create(Bot);
    const botEvents = ['info', 'err', 'debug', 'warning', 'trade'];
    botEvents.forEach(event => bot.on(event, this.emit.bind(this, event, config.steamid)));
    for (option in this.config.defaultBot) {
      if (!config.hasOwnProperty(option)) config[option] = this.config.defaultBot[option];
    }
    bot.init(config);
    const botLoggedIn = bot.start();
    const botTracked = bot.startTracking();
    await Promise.all([botTracked, botLoggedIn]);
    this.bots[config.steamid] = bot;
    return config.steamid;
  },
  loadInventory(steamid, appid, contextid, tradeable, proxy) {
    return InventoryAPI.loadInventory.call(null, steamid, appid, contextid, tradeable, proxy);
  },
  setEvent(type, name, steamid, fn) {
    if (steamid) this.bots[steamid][name].on(type, fn);
    else Object.keys(this.bots).forEach(steamid => this.bots[steamid][name].on(type, fn));
  },
  botInventories(appid, contextid, steamids = Object.keys(this.bots)) {
    const items = [];
    steamids.forEach(steamid => {
      const relevantItems = this.bots[steamid].inventory.items(appid, contextid);
      for (id in relevantItems) {
        items.push(relevantItems[id]);
      }
    });
    return items;
  }
};

Object.setPrototypeOf(Manager, EventEmitter.prototype);