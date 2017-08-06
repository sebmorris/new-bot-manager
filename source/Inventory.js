const EventEmitter = require('events').EventEmitter;
const InventoryAPI = require('steam-inventory-api');

const Inventory = {
  init(tracked, steamid, proxy, refreshInterval) {
    // Object: appid keys and contextid array values
    this.tracked = tracked;
    this.steamid = steamid;
    this.proxy = proxy;
    this.refreshInterval = refreshInterval;
    this.inventory = {};

    Object.keys(this.tracked).forEach((appid) => {
      this.inventory[appid] = {};
      this.tracked[appid].forEach((contextid) => {
        this.inventory[appid][contextid] = {};
      });
    });
  },
  startTracking(isRefresh) {
    const rs = [];

    Object.keys(this.tracked).forEach((appid) => {
      this.tracked[appid].forEach((contextid) => {
        const r = this.getInventory(appid, contextid)
          .then((inven) => {
            inven.forEach((item) => {
              // eslint-disable-next-line no-param-reassign
              item.inTrade = false;
              this.inventory[appid][contextid][item.id] = item;
            });
            return inven;
          });
        rs.push(r);
      });
    });

    if (isRefresh) {
      this.emit('info', `Tracked inventories have been refreshed ${this.steamid}`);
    } else if (this.refreshInterval) {
      setInterval(this.startTracking.bind(this, true), this.refreshInterval);
    }

    Promise.all(rs)
      .then((res) => {
        const items = [].concat(...res);
        this.emit('info', `Tracked inventories have ${items.length} items ${this.steamid}`);
      }, (err) => {
        this.emit('err', `Error tracking inventories ${err}`);
      })
      .catch((err) => {
        this.emit('err', 'Error emitting \'info\' after inventory refresh', err);
        // Possibly throw err and return this chain rather than just Promise.all();
      });

    return Promise.all(rs);
  },
  forceRefresh() {
    return this.startTracking(true);
  },
  getInventory(appid, contextid) {
    let retries = 0;
    return InventoryAPI.getInventory(this.steamid, appid, contextid, true, this.proxy)
      .catch((err) => {
        this.emit('err', `Error getting ${this.steamid}, appid: ${appid}, contextid: ${contextid}`, err);

        // TODO: check error (e.g. private inventory should return)
        if (retries !== 5) {
          this.emit('info', `Retrying getting ${this.steamid}, appid: ${appid}, contextid: ${contextid}`);
          retries += 1;
          return this.getInventory(appid, contextid);
        }
        throw err;
      });
  },
  itemsAvailable(items) {
    return items.filter(item =>
      this.inventory[item.appid][item.contextid][item.id] &&
      // eslint-disable-next-line comma-dangle
      !this.inventory[item.appid][item.contextid][item.id].inTrade
    );
  },
  removeItems(items) {
    items.forEach(item => delete this.inventory[item.appid][item.contextid][item.id]);
  },
  addItems(items) {
    items.forEach((item) => {
      this.inventory[item.appid][item.contextid][item.id] = item;
    });
  },
  setKey(items, key, value) {
    const itemsSet = [];
    items.forEach((item) => {
      try {
        const itemInPos = this.inventory[item.appid][item.contextid][item.id];
        itemInPos[key] = value;
        itemsSet.push(item);
      } catch (err) {
        this.emit('err', 'Item could not be found to set key', err);
      }
    });
    return itemsSet;
  },
  items(appid, contextid) {
    return Object.keys(this.inventory[appid][contextid])
      .map(id => this.inventory[appid][contextid][id]);
  },
};

module.exports = Inventory;

Object.setPrototypeOf(Inventory, EventEmitter.prototype);
