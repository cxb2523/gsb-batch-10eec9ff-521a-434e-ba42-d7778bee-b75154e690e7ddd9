import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

import {omit} from 'lodash';

export const Tones = new Mongo.Collection('tones');

if (!Meteor.isServer) return false

Meteor.publish('tones', () => Tones.find())

Meteor.methods({
  'tones.insert'(tone) {
    return Tones.insert(tone);
  },

  // Keep exactly one record per sound: the existing document is updated in
  // place (its _id - and therefore its identity for the mixer - is stable),
  // and any duplicate left behind by a previous run is removed.
  'tones.replace'(tone) {
    let fields = omit(tone, '_id');
    let existing = Tones.findOne({soundId: fields.soundId});

    if (existing) {
      Tones.remove({soundId: fields.soundId, _id: { $ne: existing._id }});

      // the creation date identifies the record, it must not change when the
      // sound is re-evaluated (otherwise the mixer strips would be reordered
      // on every code change).
      if (!fields.createdAt) fields.createdAt = existing.createdAt;

      Tones.update(existing._id, { $set: fields });
      return existing._id;
    }

    Tones.remove({soundId: fields.soundId});
    if (!fields.createdAt) fields.createdAt = new Date();

    return Tones.insert(fields);
  },

  'tones.removeFromSoundId'(soundId) {
    Tones.remove({soundId: soundId});
  },

  'tones.removeAll'() {
    Tones.remove({});
  },

  'tones.update'(tone) {
    if (!tone || !tone._id) return false;

    // _id is immutable, it must never be part of the $set document.
    let fields = omit(tone, '_id');
    Tones.update(tone._id, { $set: fields });
    return true;
  }
});
