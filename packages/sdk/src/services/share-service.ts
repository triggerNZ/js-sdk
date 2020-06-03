import { Connection, Share, Slot } from '@meeco/vault-api-sdk';
import { AuthData } from '../models/auth-data';
import { EncryptionKey } from '../models/encryption-key';
import { EncryptionSpaceData } from '../models/encryption-space-data';
import { Environment } from '../models/environment';
import { DecryptedSlot } from '../models/local-slot';
import { MeecoServiceError } from '../models/service-error';
import {
  KeystoreAPIFactory,
  keystoreAPIFactory,
  vaultAPIFactory,
  VaultAPIFactory
} from '../util/api-factory';
import { findConnectionBetween } from '../util/find-connection-between';
import cryppo from './cryppo-service';
import { ItemService } from './item-service';

interface ISharedEncryptionSpace {
  from_user_connection_id: string;
  to_user_connection_id: string;
  shared_data_encryption_key?: EncryptionKey;
}

export class ShareService {
  static Date = global.Date;
  private cryppo = (<any>global).cryppo || cryppo;

  private keystoreApiFactory: KeystoreAPIFactory;
  private vaultApiFactory: VaultAPIFactory;

  constructor(private environment: Environment, private log: (message: string) => void) {
    this.keystoreApiFactory = keystoreAPIFactory(environment);
    this.vaultApiFactory = vaultAPIFactory(environment);
  }

  public async shareItem(fromUser: AuthData, toUser: AuthData, itemId: string) {
    const { fromUserConnection, toUserConnection } = await findConnectionBetween(
      fromUser,
      toUser,
      this.environment,
      this.log
    );

    this.log('Fetching shared encryption space');
    const sharedEncryptionSpace = await this.fetchSharedEncryptionSpace(
      fromUser,
      toUser,
      fromUserConnection,
      toUserConnection
    );

    const share = await this.shareItemFromVaultItem(
      fromUser,
      toUser,
      sharedEncryptionSpace,
      itemId,
      fromUserConnection.user_id
    );

    this.log('Sending shared data');
    const shareResult = await this.vaultApiFactory(fromUser).SharesApi.sharesPost({
      shares: [share]
    });
    return {
      ...share,
      share: shareResult
    };
  }

  public async listShares(user: AuthData) {
    return await this.vaultApiFactory(user).SharesApi.sharesIncomingGet();
  }

  public async getSharedItem(user: AuthData, itemId: string) {
    const result = await this.vaultApiFactory(user)
      .SharesApi.sharesIdGet(itemId)
      .catch(err => {
        if ((<Response>err).status === 404) {
          throw new MeecoServiceError(`Share with id '${itemId}' not found for the specified user`);
        }
        throw err;
      });
    const { item, share } = result;

    await this.ensureClaimedKey(user, share.connection_id);

    const slots = this.addShareValuesToSlots(share, result.slots);
    const space = await this.keystoreApiFactory(user).EncryptionSpaceApi.encryptionSpacesIdGet(
      share.encryption_space_id!
    );
    const decryptedSharedDataEncryptionKey = await this.cryppo.decryptWithKey({
      serialized: space.encryption_space_data_encryption_key.serialized_data_encryption_key,
      key: user.key_encryption_key.key
    });
    const key = EncryptionKey.fromRaw(decryptedSharedDataEncryptionKey);
    const decryptedSlots = await ItemService.decryptAllSlots(slots!, key);

    return {
      item,
      slots: decryptedSlots
    };
  }

  private addShareValuesToSlots(share: Share, slots: Slot[]) {
    slots.forEach(slot => {
      slot.encrypted_value = (share?.encrypted_values || {})[slot.id];
    });
    return slots;
  }

  private async shareItemFromVaultItem(
    fromUser: AuthData,
    toUser: AuthData,
    sharedEncryptionSpace: ISharedEncryptionSpace,
    itemId: string,
    toUserId: string
  ) {
    const item = await this.vaultApiFactory(fromUser).ItemApi.itemsIdGet(itemId);

    if (!item) {
      throw new MeecoServiceError(`Item '${itemId}' not found`);
    }
    const { slots } = item;

    if (!sharedEncryptionSpace.shared_data_encryption_key) {
      this.log('No encryption space found - creating one');
      sharedEncryptionSpace = await this.configureSharedEncryptionSpace(
        fromUser,
        sharedEncryptionSpace.from_user_connection_id,
        toUser,
        sharedEncryptionSpace.to_user_connection_id
      );
    }

    this.log('Decrypting all slots');
    const decryptedSlots = await ItemService.decryptAllSlots(slots!, fromUser.data_encryption_key);
    this.log('Encrypting slots with shared key');
    const encrypted_values = await this.convertSlotsToEncryptedValuesForShare(
      decryptedSlots,
      sharedEncryptionSpace.shared_data_encryption_key!
    );
    return {
      shareable_id: itemId,
      shareable_type: 'Item',
      encrypted_values,
      distributable: false,
      outgoing: true,
      // TODO - this should be the connection id but API does not support it yet
      user_id: toUserId
    };
  }

  public async configureSharedEncryptionSpace(
    fromUser: AuthData,
    fromUserConnectionId: string,
    toUser: AuthData,
    toUserConnectionId: string
  ) {
    const fromResult = await this.createSharedEncryptionSpace(fromUser, fromUserConnectionId);
    const toResult = await this.ensureClaimedKey(toUser, toUserConnectionId);

    return {
      from_user_connection_id: fromResult.connectionId,
      to_user_connection_id: toResult.connection.id,
      shared_data_encryption_key: EncryptionKey.fromRaw(fromResult.dataEncryptionKey)
    };
  }

  public async fetchSharedEncryptionSpace(
    fromUser: AuthData,
    toUser: AuthData,
    fromUserConnection: Connection,
    toUserConnection: Connection
  ): Promise<ISharedEncryptionSpace> {
    if (!fromUserConnection.encryption_space_id) {
      // Users have no shared encryption space
      return new EncryptionSpaceData({
        from_user_connection_id: fromUserConnection.id,
        to_user_connection_id: toUserConnection!.id
      });
    }

    if (!toUserConnection.encryption_space_id) {
      this.log('Shared encryption space does not appear to be claimed - claiming...');
      await this.claimSharedEncryptionSpace(toUser, toUserConnection);
    }

    this.log('Fetching shared encryption key');
    const sharedDataEncryptionKey = await this.keystoreApiFactory(
      fromUser
    ).EncryptionSpaceApi.encryptionSpacesIdGet(fromUserConnection.encryption_space_id);

    const decryptedSharedDataEncryptionKey = await this.cryppo.decryptWithKey({
      serialized: sharedDataEncryptionKey.encryption_space_data_encryption_key
        ?.serialized_data_encryption_key!,
      key: fromUser.key_encryption_key.key
    });

    return new EncryptionSpaceData({
      from_user_connection_id: fromUserConnection.id,
      to_user_connection_id: toUserConnection!.id,
      shared_data_encryption_key: EncryptionKey.fromRaw(decryptedSharedDataEncryptionKey)
    });
  }

  private async createSharedEncryptionSpace(fromUser: AuthData, connectionId: string) {
    this.log('Generating from user data encryption key');
    const fromUserEncryptionSpace = await this.createAndStoreNewDataEncryptionKey(fromUser);
    const encryptionSpaceId = fromUserEncryptionSpace.encryptionSpace?.encryption_space_id!;

    this.log('Fetching connection');
    const connection = await this.fetchConnectionWithId(fromUser, connectionId);

    const recipientPublicKey = connection.other_user_connection_public_key;
    if (!recipientPublicKey) {
      throw new MeecoServiceError('Other user public key missing!');
    }

    const shareableDataEncryptionKey = await this.cryppo.encryptWithPublicKey({
      data: fromUserEncryptionSpace.dataEncryptionKey,
      publicKeyPem: recipientPublicKey
    });

    this.log('Updating connection encryption space');
    await this.vaultApiFactory(fromUser).ConnectionApi.connectionsConnectionIdEncryptionSpacePost(
      connection.id!,
      {
        encryption_space_id: encryptionSpaceId
      }
    );

    this.log('Sending shared key');
    const sharedKey = await this.keystoreApiFactory(fromUser).SharedKeyApi.sharedKeysPost({
      encrypted_key: shareableDataEncryptionKey.serialized,
      external_id: encryptionSpaceId,
      public_key: recipientPublicKey,
      key_metadata: {
        key_type: this.cryppo.CipherStrategy.AES_GCM
      }
    });
    return {
      connection,
      dataEncryptionKey: fromUserEncryptionSpace.dataEncryptionKey,
      connectionId,
      fromUserSharedKey: sharedKey.shared_key
    };
  }

  private async ensureClaimedKey(user: AuthData, connectionId: string) {
    const connection = await this.fetchConnectionWithId(user, connectionId);
    if (!connection.encryption_space_id) {
      this.log('Shared data encryption key not yet claimed - claiming');
      return this.claimSharedEncryptionSpace(user, connection);
    }

    return {
      connection
    };
  }

  private async claimSharedEncryptionSpace(toUser: AuthData, connection: Connection) {
    const encryptionSpaceId = connection.other_user_connection_encryption_space_id!;
    this.log('Fetching key pair');
    const keyPair = await this.keystoreApiFactory(toUser)
      .KeypairApi.keypairsIdGet(connection.key_store_keypair_id)
      .then(res => res.keypair);

    const privateKey = await this.cryppo.decryptWithKey({
      serialized: keyPair.encrypted_serialized_key,
      key: toUser.key_encryption_key.key
    });
    this.log('Claiming data encryption key');
    const reEncryptedDataEncryptionKey = await this.claimAndReEncryptSharedDataEncryptionKey(
      toUser,
      encryptionSpaceId,
      {
        publicKey: keyPair.public_key,
        privateKey
      }
    );

    this.log('Creating new encryption space with re-encrypted claimed key');
    const encryptionSpace = await this.keystoreApiFactory(
      toUser
    ).EncryptionSpaceApi.encryptionSpacesPost({
      encrypted_serialized_key: reEncryptedDataEncryptionKey.serialized
    });
    const { encryption_space_id } = encryptionSpace.encryption_space_data_encryption_key!;

    this.log('Updating shared encryption space');
    await this.vaultApiFactory(toUser).ConnectionApi.connectionsConnectionIdEncryptionSpacePost(
      connection.id,
      {
        encryption_space_id
      }
    );

    return {
      connection
    };
  }

  private async createAndStoreNewDataEncryptionKey(user: AuthData) {
    const dataEncryptionKey = this.cryppo.generateRandomKey();
    const encryptedDataEncryptionKey = await this.cryppo.encryptWithKey({
      data: dataEncryptionKey,
      key: user.key_encryption_key.key,
      strategy: this.cryppo.CipherStrategy.AES_GCM
    });
    const encryptionSpace = await this.keystoreApiFactory(user)
      .EncryptionSpaceApi.encryptionSpacesPost({
        encrypted_serialized_key: encryptedDataEncryptionKey.serialized
      })
      .then(result => result.encryption_space_data_encryption_key);

    return {
      dataEncryptionKey,
      encryptionSpace
    };
  }

  private async claimAndReEncryptSharedDataEncryptionKey(
    user: AuthData,
    encryptionSpaceId: string,
    keyPair: {
      privateKey: string;
      publicKey: string;
    }
  ) {
    const signature = await this.buildClaimKeySignature(encryptionSpaceId, keyPair.privateKey);
    const claimedKey = await this.keystoreApiFactory(user)
      .SharedKeyApi.sharedKeysExternalIdClaimKeyPost(encryptionSpaceId, {
        public_key: keyPair.publicKey,
        request_signature: signature.serialized
      })
      .catch(async err => {
        if (err?.status === 403 && typeof err?.json === 'function') {
          const json = await err.json();
          if (json?.errors[0].error === 'invalid_request_signature') {
            throw new MeecoServiceError(
              `Failed to claim shared encryption key - the request signature was rejected by the API`
            );
          }
        }
        throw err;
      });
    const decryptedDataEncryptionKey = await this.cryppo.decryptSerializedWithPrivateKey({
      serialized: claimedKey.shared_key_claimed?.serialized_shared_key!,
      privateKeyPem: keyPair.privateKey
    });
    const reEncryptedDataEncryptionKey = await this.cryppo.encryptWithKey({
      key: user.key_encryption_key.key,
      data: decryptedDataEncryptionKey,
      strategy: this.cryppo.CipherStrategy.AES_GCM
    });

    return reEncryptedDataEncryptionKey;
  }

  private buildClaimKeySignature(encryptionSpaceId: string | undefined, privateKey: string) {
    const requestUrl = `${this.environment.keystore.url}/shared_keys/${encryptionSpaceId}/claim_key`;
    const verification = `--request-timestamp=${new ShareService.Date().toISOString()}`;
    const urlToSign = requestUrl + verification;
    return this.cryppo.signWithPrivateKey(privateKey, urlToSign);
  }

  private async fetchConnectionWithId(user: AuthData, connectionId: string) {
    this.log('Fetching connection');
    const connectionResponse = await this.vaultApiFactory(user).ConnectionApi.connectionsIdGet(
      connectionId
    );
    const connection = connectionResponse.connection;
    if (!connection || !connection.id) {
      throw new MeecoServiceError(`Connection '${connectionId}' not found.`);
    }
    return connection;
  }

  /**
   * In the API: a share expects an `encrypted_value` property.
   * For a tile item - this is a stringified json payload of key/value
   * pairs where the key is the slot id and the value is the slot value
   * encrypted with a shared data encryption key.
   */
  private async convertSlotsToEncryptedValuesForShare(
    slots: DecryptedSlot[],
    sharedDataEncryptionKey: EncryptionKey
  ) {
    const encryptions = slots.map(async slot => {
      const encrypted =
        typeof slot.value === 'string'
          ? await cryppo
              .encryptWithKey({
                data: slot.value || '',
                key: sharedDataEncryptionKey.key,
                strategy: this.cryppo.CipherStrategy.AES_GCM
              })
              .then(result => result.serialized)
          : slot.value;
      return {
        [slot.id!]: encrypted
      };
    });
    const encryptedSlots = await Promise.all(encryptions);
    const encrypted_values = JSON.stringify(
      encryptedSlots.reduce((prev, next) => ({ ...prev, ...next }), {})
    );
    return encrypted_values;
  }
}