import mongoose from 'mongoose';
import groupBy from 'lodash/groupBy';
import shuffle from 'lodash/shuffle';
import escapeStringRegExp from 'escape-string-regexp';

import NotFoundError from '../errors/NotFoundError';
import Page from '../Page';

function isValidPlaylistItem(item) {
  return typeof item === 'object' &&
    typeof item.sourceType === 'string' &&
    (typeof item.sourceID === 'string' || typeof item.sourceID === 'number');
}

/**
 * Calculate valid start/end times for a playlist item.
 */
function getStartEnd(item, media) {
  let { start, end } = item;
  if (!start || start < 0) {
    start = 0;
  } else if (start > media.duration) {
    start = media.duration;
  }
  if (!end || end > media.duration) {
    end = media.duration;
  } else if (end < start) {
    end = start;
  }
  return { start, end };
}

function toPlaylistItem(itemProps, media) {
  const { artist, title } = itemProps;
  const { start, end } = getStartEnd(itemProps, media);
  return {
    _id: new mongoose.Types.ObjectId(),
    media,
    artist: artist || media.artist,
    title: title || media.title,
    start,
    end
  };
}

function filterPlaylistItems(items, filter) {
  if (!filter) {
    return items;
  }

  const rx = new RegExp(escapeStringRegExp(filter), 'i');
  return items.filter(item => rx.test(item.artist) || rx.test(item.title));
}

export class PlaylistsRepository {
  constructor(uw) {
    this.uw = uw;
  }

  async getPlaylist(id) {
    const Playlist = this.uw.model('Playlist');
    if (id instanceof Playlist) {
      return id;
    }
    const playlist = await Playlist.findById(id);
    if (!playlist) {
      throw new NotFoundError('Playlist not found.');
    }

    return playlist;
  }

  async getUserPlaylist(user, id) {
    const Playlist = this.uw.model('Playlist');
    const userID = typeof user === 'object' ? user.id : user;
    const playlist = await Playlist.findOne({ _id: id, author: userID });
    if (!playlist) {
      throw new NotFoundError('Playlist not found.');
    }

    return playlist;
  }

  async createPlaylist(user, { name }) {
    const Playlist = this.uw.model('Playlist');

    const playlist = await Playlist.create({
      name,
      author: user
    });

    return playlist;
  }

  async getUserPlaylists(user) {
    const Playlist = this.uw.model('Playlist');
    const playlists = await Playlist.where('author').eq(user);

    return playlists;
  }

  async updatePlaylist(playlistOrID, patch = {}) {
    const playlist = await this.getPlaylist(playlistOrID);
    Object.assign(playlist, patch);
    return playlist.save();
  }

  async shufflePlaylist(playlistOrID) {
    const playlist = await this.getPlaylist(playlistOrID);
    playlist.items = shuffle(playlist.items);
    return playlist.save();
  }

  async deletePlaylist(playlistOrID) {
    const playlist = await this.getPlaylist(playlistOrID);

    await playlist.remove();

    return {};
  }

  async getPlaylistItem(playlistOrID, itemID) {
    const playlist = await this.getPlaylist(playlistOrID);
    return this.getPlaylistItemAt(playlist,
      playlist.items.findIndex(it => it.id === itemID));
  }

  async getPlaylistItemAt(playlistOrID, index) {
    const Media = this.uw.model('Media');
    const playlist = await this.getPlaylist(playlistOrID);
    const item = playlist.items[index];

    if (!item) {
      throw new NotFoundError('Playlist item not found.');
    }

    if (!item.populated('media')) {
      item.media = await Media.findById(item.media);
    }

    return item;
  }

  async getPlaylistItems(playlistOrID, filter = null, pagination = null) {
    const Media = this.uw.model('Media');
    const playlist = await this.getPlaylist(playlistOrID);
    const allFilteredItems = filterPlaylistItems(playlist.items, filter);

    let filteredItems = allFilteredItems;
    if (pagination) {
      const start = pagination.offset;
      const end = start + pagination.limit;
      filteredItems = filteredItems.slice(start, end);
    }
    if (filteredItems.length > 0) {
      const medias = await Media.find({
        _id: { $in: filteredItems.map(item => item.media) }
      });
      filteredItems.forEach((item) => {
        item.set('media', medias.find(media => media.id === `${item.media}`));
      });
    }

    return new Page(filteredItems, {
      pageSize: pagination ? pagination.limit : null,
      filtered: allFilteredItems.length,
      total: playlist.size,

      current: pagination,
      next: pagination ? {
        offset: pagination.offset + pagination.limit,
        limit: pagination.limit
      } : null,
      previous: pagination ? {
        offset: Math.max(pagination.offset - pagination.limit, 0),
        limit: pagination.limit
      } : null
    });
  }

  async getMedia(props) {
    const Media = this.uw.model('Media');

    const { sourceType, sourceID } = props;
    let media = await Media.findOne({ sourceType, sourceID });
    if (!media) {
      const mediaProps = await this.uw.source(sourceType).getOne(sourceID);
      media = await Media.create(mediaProps);
    }
    return media;
  }

  /**
   * Create a playlist item.
   */
  async createItem(props) {
    const PlaylistItem = this.uw.model('PlaylistItem');

    const media = await this.getMedia(props);
    const playlistItem = new PlaylistItem(toPlaylistItem(props, media));

    try {
      await playlistItem.save();
    } catch (e) {
      throw new Error('Could not save playlist items. Please try again later.');
    }

    return playlistItem;
  }

  /**
   * Bulk create playlist items from arbitrary sources.
   */
  async createPlaylistItems(items) {
    const Media = this.uw.model('Media');

    if (!items.every(isValidPlaylistItem)) {
      throw new Error('Cannot add a playlist item without a proper media source type and ID.');
    }

    // Group by source so we can retrieve all unknown medias from the source in
    // one call.
    const itemsBySourceType = groupBy(items, 'sourceType');
    const playlistItems = [];
    const promises = Object.keys(itemsBySourceType).map(async (sourceType) => {
      const sourceItems = itemsBySourceType[sourceType];
      const knownMedias = await Media.find({
        sourceType,
        sourceID: { $in: sourceItems.map(item => item.sourceID) }
      });

      const unknownMediaIDs = [];
      sourceItems.forEach((item) => {
        if (!knownMedias.some(media => media.sourceID === String(item.sourceID))) {
          unknownMediaIDs.push(item.sourceID);
        }
      });

      let allMedias = knownMedias;
      if (unknownMediaIDs.length > 0) {
        const unknownMedias = await this.uw.source(sourceType).get(unknownMediaIDs);
        allMedias = allMedias.concat(await Media.create(unknownMedias));
      }

      const itemsWithMedia = sourceItems.map(item => toPlaylistItem(
        item,
        allMedias.find(media => media.sourceID === String(item.sourceID))
      ));
      playlistItems.push(...itemsWithMedia);
    });

    await Promise.all(promises);

    return playlistItems;
  }

  /**
   * Add items to a playlist.
   */
  async addPlaylistItems(playlistOrID, items, { after = null } = {}) {
    const playlist = await this.getPlaylist(playlistOrID);
    const newItems = await this.createPlaylistItems(items);
    const oldMedia = playlist.items;
    const insertIndex = oldMedia.findIndex(item => `${item}` === after);
    playlist.items = [
      ...oldMedia.slice(0, insertIndex + 1),
      ...newItems,
      ...oldMedia.slice(insertIndex + 1)
    ];

    await playlist.save();

    return {
      added: newItems,
      afterID: after,
      playlistSize: playlist.size
    };
  }

  async updatePlaylistItem(itemOrID, patch = {}) {
    const item = await this.getPlaylistItem(itemOrID);

    Object.assign(item, patch);

    return item.save();
  }

  async movePlaylistItems(playlistOrID, itemIDs, { afterID }) {
    const playlist = await this.getPlaylist(playlistOrID);

    // First remove the given items,
    const newMedia = playlist.items.filter(
      item => itemIDs.indexOf(item.id) === -1);
    const movedItems = playlist.items.filter(
      item => itemIDs.indexOf(item.id) !== -1);
    // then reinsert them at their new position.
    const insertIndex = newMedia.findIndex(item => item.id === afterID);
    newMedia.splice(insertIndex + 1, 0, ...movedItems);
    playlist.items = newMedia;

    await playlist.save();

    return {};
  }

  async removePlaylistItems(playlistOrID, itemsOrIDs) {
    const playlist = await this.getPlaylist(playlistOrID);

    // Only remove items that are actually in this playlist.
    const stringIDs = itemsOrIDs.map(item => String(item));
    const toRemove = [];
    const toKeep = [];
    playlist.items.forEach((item) => {
      if (stringIDs.indexOf(item.id) !== -1) {
        toRemove.push(item);
      } else {
        toKeep.push(item);
      }
    });

    playlist.items = toKeep;
    await playlist.save();
    // TODO Is the `toRemove` array useful for anything still?

    return {};
  }
}

export default function playlistsPlugin() {
  return (uw) => {
    uw.playlists = new PlaylistsRepository(uw); // eslint-disable-line no-param-reassign
  };
}
