import mongoose from 'mongoose';
import { createSchema } from 'mongoose-model-decorators';

import NotFoundError from '../errors/NotFoundError';
import Page from '../Page';

const Types = mongoose.Schema.Types;

export default function playlistModel() {
  return (uw) => {
    class Playlist {
      static timestamps = true;
      static toJSON = { getters: true };

      static schema = {
        name: { type: String, min: 0, max: 128, required: true },
        description: { type: String, min: 0, max: 512 },
        author: { type: Types.ObjectId, ref: 'User', required: true, index: true },
        shared: { type: Boolean, default: false },
        nsfw: { type: Boolean, default: false },

        // Old-style media references.
        media: [{ type: Types.ObjectId, ref: 'PlaylistItem', index: true }],

        // New-style embedded media objects.
        items: [
          {
            _id: { type: Types.ObjectId, required: true },
            media: { type: Types.ObjectId, ref: 'Media', required: true },
            artist: { type: String, max: 128, required: true, index: true },
            title: { type: String, max: 128, required: true, index: true },
            start: { type: Number, min: 0, default: 0 },
            end: { type: Number, min: 0, default: 0 }
          }
        ]
      };

      get size(): number {
        return this.media.length;
      }

      getItem(id) {
        if (!this.media.some(item => `${item}` === `${id}`)) {
          throw new NotFoundError('Playlist item not found.');
        }
        return uw.playlists.getPlaylistItem(id);
      }

      getItemAt(index): Promise {
        return uw.playlists.getPlaylistItem(this.media[index]);
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
