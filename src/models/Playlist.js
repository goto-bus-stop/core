import mongoose from 'mongoose';
import { createSchema, pre, post } from 'mongoose-model-decorators';
import createDebug from 'debug';

import NotFoundError from '../errors/NotFoundError';
import Page from '../Page';

const Types = mongoose.Schema.Types;
const debug = createDebug('uwave:core:playlist-model');

const CURRENT_SCHEMA_VERSION = 2;

/**
 * Check if a playlist is an old-style playlist, with a `.media` property
 * containing item IDs. New-style playlists have an `.items` property containing
 * item objects.
 *
 * @param {Playlist} playlist
 */
function isOldStylePlaylist(playlist) {
  return !playlist.version || playlist.version < CURRENT_SCHEMA_VERSION;
}

/**
 * Upgrade a playlist from the old `.media` to the new `.items` storage style.
 *
 * @param {Playlist} playlist
 */
async function upgradePlaylist(playlist) {
  debug('upgrading playlist', playlist._id);

  const PlaylistItem = playlist.model('PlaylistItem');
  const items = await PlaylistItem.find({
    _id: { $in: playlist.media }
  }).lean();

  debug('# of items', items.length);

  playlist.set('version', CURRENT_SCHEMA_VERSION);
  playlist.set('items', items);
  playlist.set('media', undefined);

  debug('saving upgraded playlist...');
  await playlist.save();
}

export default function playlistModel() {
  return (uw) => {
    class PlaylistItem {
      static timestamps = true;

      static schema = {
        _id: { type: Types.ObjectId, required: true },
        media: { type: Types.ObjectId, ref: 'Media', required: true },
        artist: { type: String, max: 128, required: true, index: true },
        title: { type: String, max: 128, required: true, index: true },
        start: { type: Number, min: 0, default: 0 },
        end: { type: Number, min: 0, default: 0 }
      };
    }

    const PlaylistItemSchema = createSchema({ minimize: false })(PlaylistItem);

    class Playlist {
      static timestamps = true;
      static toJSON = { getters: true };

      static schema = {
        name: { type: String, min: 0, max: 128, required: true },
        description: { type: String, min: 0, max: 512 },
        author: { type: Types.ObjectId, ref: 'User', required: true, index: true },
        shared: { type: Boolean, default: false },
        nsfw: { type: Boolean, default: false },

        // Default to `-1` to identify old models that don't have a version.
        // New models get a version number in the `setDefaultVersion` method.
        version: { type: Number, default: -1 },

        // Old-style media references.
        media: [{ type: Types.ObjectId, ref: 'PlaylistItem', index: true }],

        // New-style embedded media objects.
        items: [new PlaylistItemSchema()]
      };

      @post('init')
      maybeUpgradePlaylist(doc, next) {
        debug('post-init', doc.version);
        if (isOldStylePlaylist(doc)) {
          upgradePlaylist(doc).then(next);
        } else {
          next();
        }
      }

      @pre('save')
      setDefaultVersion(next) {
        // Only assign a version to new documents.
        if (this.isNew && !this.version) {
          this.version = CURRENT_SCHEMA_VERSION;
        }

        next();
      }

      get size(): number {
        return this.items.length;
      }

      getItem(id) {
        if (!this.items.some(item => `${item}` === `${id}`)) {
          throw new NotFoundError('Playlist item not found.');
        }
        return uw.playlists.getPlaylistItem(this, id);
      }

      getItemAt(index): Promise {
        return uw.playlists.getPlaylistItemAt(this, index);
      }

      getItems(filter, page): Promise<Page> {
        return uw.playlists.getPlaylistItems(this, filter, page);
      }

      addItems(items, opts = {}): Promise {
        return uw.playlists.addPlaylistItems(this, items, opts);
      }

      async updateItem(id, patch = {}): Promise {
        const item = await this.getItem(id);
        return uw.playlists.updatePlaylistItem(item, patch);
      }

      shuffle(): Promise {
        return uw.playlists.shufflePlaylist(this);
      }

      moveItems(ids, afterID) {
        return uw.playlists.movePlaylistItems(this, ids, afterID);
      }

      removeItem(id): Promise {
        return this.removeItems([id]);
      }

      removeItems(ids): Promise {
        return uw.playlists.removePlaylistItems(this, ids);
      }
    }

    const PlaylistSchema = createSchema({ minimize: false })(Playlist);

    return uw.mongo.model('Playlist', new PlaylistSchema());
  };
}
