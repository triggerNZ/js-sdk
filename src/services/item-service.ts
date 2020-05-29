import * as cryppo from '@meeco/cryppo';
import { CipherStrategy, decryptWithKey, encryptWithKey } from '@meeco/cryppo';
import { binaryBufferToString } from '@meeco/cryppo/dist/src/util';
import { AttachmentResponse, Slot, ThumbnailResponse } from '@meeco/vault-api-sdk';
import { CLIError } from '@oclif/errors';
import { createReadStream } from 'fs';
import * as Jimp from 'jimp';
import { lookup } from 'mime-types';
import { basename } from 'path';
import { FileAttachmentConfig } from '../configs/file-attachment-config';
import { ItemConfig } from '../configs/item-config';
import { ItemListConfig } from '../configs/item-list-config';
import { AuthData } from '../models/auth-data';
import { EncryptionKey } from '../models/encryption-key';
import { IEnvironment } from '../models/environment';
import { LocalSlot } from '../models/local-slot';
import { VaultAPIFactory, vaultAPIFactory } from '../util/api-factory';
import { deleteFileSync, readFileAsBuffer, writeFileContents } from '../util/file';

export class ItemService {
  private vaultAPIFactory: VaultAPIFactory;
  constructor(environment: IEnvironment, private log: (message: string) => void = () => {}) {
    this.vaultAPIFactory = vaultAPIFactory(environment);
  }

  /**
   * Updates 'value' to the decrypted 'encrypted_value' and sets 'encrypted' to false.
   */
  public static decryptAllSlots(slots: Slot[], dataEncryptionKey: EncryptionKey): Promise<Slot[]> {
    return Promise.all(
      slots.map(async slot => {
        const value =
          slot.encrypted && slot.encrypted_value !== null // need to check encrypted_value as binaries will also have `encrypted: true`
            ? await cryppo.decryptWithKey({
                key: dataEncryptionKey.key,
                serialized: slot.encrypted_value
              })
            : (slot as LocalSlot).value;
        const decrypted = {
          ...slot,
          encrypted: false,
          value
        };
        return decrypted as LocalSlot;
      })
    );
  }

  public async create(vaultAccessToken: string, dek: EncryptionKey, config: ItemConfig) {
    const slots_attributes = await Promise.all(
      (config.itemConfig.slots || []).map(slot => this.encryptSlot(slot, dek))
    );

    const result = await this.vaultAPIFactory(vaultAccessToken).ItemApi.itemsPost({
      template_name: config.templateName,
      item: {
        label: config.itemConfig.label,
        slots_attributes
      }
    });

    return ItemConfig.encodeFromJson({
      ...result.item,
      slots: result.slots?.map(slot => ({
        ...slot
      }))
    });
  }

  private async getStringAsFileStream(fileContents: string) {
    // No matter what was attempted, the only way to get a binary to upload in multi-part formdata was to pass it in as a ReadStream
    // so we need to encrypt the file, write it down to a temp file and then read it back in again for upload
    const tmpEncryptedFile = `./.encrypted_file_tmp`;
    await writeFileContents(tmpEncryptedFile, fileContents);
    const fileStream = createReadStream(tmpEncryptedFile);
    const removeTempEncryptedFile = () => deleteFileSync(tmpEncryptedFile);
    return {
      fileStream,
      removeTempEncryptedFile
    };
  }

  public async generateAndUploadThumbnail(file: Buffer, binaryId: string, auth: AuthData) {
    const targetThumbnailSize = 256;
    const sizeType = `png_${targetThumbnailSize}x${targetThumbnailSize}`;

    this.log('Generating image thumbnail');
    const jimp = await Jimp.read(file);
    const thumbnail: Buffer = await jimp
      .resize(targetThumbnailSize, targetThumbnailSize)
      .getBufferAsync(Jimp.MIME_PNG);

    this.log('Encrypting image thumbnail');
    const encryptedThumbnail = await cryppo.encryptWithKey({
      key: auth.data_encryption_key.key,
      data: binaryBufferToString(thumbnail),
      strategy: CipherStrategy.AES_GCM
    });

    this.log('Uploading encrypted image thumbnail');
    const fileUpload = await this.getStringAsFileStream(encryptedThumbnail.serialized);
    let response: ThumbnailResponse;
    try {
      response = await this.vaultAPIFactory(auth).ThumbnailApi.thumbnailsPost(
        fileUpload.fileStream as any,
        binaryId,
        sizeType
      );
    } catch (err) {
      this.log('Error uploading encrypted thumbnail file!');
      throw err;
    } finally {
      fileUpload.removeTempEncryptedFile();
    }

    return response;
  }

  public async attachFile(config: FileAttachmentConfig, auth: AuthData) {
    let file: Buffer, fileName: string, fileType: string;
    const filePath = config.template.file;
    this.log('Reading file');
    try {
      file = await readFileAsBuffer(filePath);
      fileName = basename(filePath);
      fileType = lookup(filePath) || 'application/octet-stream';
    } catch (err) {
      throw new CLIError(
        `Failed to read file '${config.template.file}' - please check that the file exists and is readable`
      );
    }

    this.log('Fetching item');
    const item = await this.get(
      config.itemId,
      auth.vault_access_token,
      auth.data_encryption_key
    ).catch(err => {
      throw new CLIError(
        `Unable to find item '${config.itemId}' - please check that the item exists for the current user.`
      );
    });

    this.log('Encrypting File');
    const encryptedFile = await cryppo.encryptWithKey({
      key: auth.data_encryption_key.key,
      data: binaryBufferToString(file),
      strategy: CipherStrategy.AES_GCM
    });

    const fileUpload = await this.getStringAsFileStream(encryptedFile.serialized);

    let uploadedBinary: AttachmentResponse;
    try {
      this.log('Uploading encrypted file');
      uploadedBinary = await this.vaultAPIFactory(
        auth.vault_access_token
      ).AttachmentApi.attachmentsPost(fileUpload.fileStream as any, fileName, fileType);
    } catch (err) {
      this.log('Upload encrypted file failed - removing temp encrypted version');
      throw err;
    } finally {
      fileUpload.removeTempEncryptedFile();
    }

    if (fileType.startsWith('image/')) {
      try {
        await this.generateAndUploadThumbnail(file, uploadedBinary.attachment.id, auth);
      } catch (err) {
        console.log('Creating thumbnail failed - continuing without thumbnail');
        console.log(err.message);
      }
    }

    this.log('Adding attachment to item');
    const updated = await this.vaultAPIFactory(auth.vault_access_token).ItemApi.itemsIdPut(
      item.spec.id,
      {
        item: {
          slots_attributes: [
            {
              label: config.template.label,
              slot_type_name: 'attachment',
              attachments_attributes: [
                {
                  id: uploadedBinary.attachment.id
                }
              ]
            }
          ]
        }
      }
    );
    this.log('File was successfully attached');
    return ItemConfig.encodeFromJson({
      ...updated.item,
      slots: updated.slots
    });
  }

  private async downloadAndDecryptFile<T extends Blob>(
    download: () => Promise<T>,
    dataEncryptionKey: EncryptionKey,
    destination: string
  ) {
    const result = await download();
    const buffer = await (<any>result).arrayBuffer();
    const encryptedContents = await binaryBufferToString(buffer);
    const decryptedContents = await decryptWithKey({
      serialized: encryptedContents,
      key: dataEncryptionKey.key
    });
    this.log('Writing decrypted file to destination');
    return writeFileContents(destination, decryptedContents, {
      flag: 'wx' // Write if not exists but fail if the file exists
    }).catch(err => {
      if (err.code === 'EEXIST') {
        throw new CLIError('The destination file exists - please use a different destination file');
      } else {
        throw new CLIError(`Failed to write to destination file: '${err.message}'`);
      }
    });
  }

  public async downloadAttachment(
    id: string,
    vaultAccessToken: string,
    dataEncryptionKey: EncryptionKey,
    destination: string
  ) {
    this.log('Downloading attachment');
    return this.downloadAndDecryptFile(
      () => this.vaultAPIFactory(vaultAccessToken).AttachmentApi.attachmentsIdDownloadGet(id),
      dataEncryptionKey,
      destination
    );
  }

  public async downloadThumbnail(
    id: string,
    vaultAccessToken: string,
    dataEncryptionKey: EncryptionKey,
    destination: string
  ) {
    this.log('Downloading thumbnail');
    return this.downloadAndDecryptFile(
      () => this.vaultAPIFactory(vaultAccessToken).ThumbnailApi.thumbnailsIdGet(id),
      dataEncryptionKey,
      destination
    );
  }

  public async removeSlot(slotId: string, vaultAccessToken: string) {
    this.log('Removing slot');
    await this.vaultAPIFactory(vaultAccessToken).SlotApi.slotsIdDelete(slotId);
    this.log('Slot successfully removed');
  }

  public async get(id: string, vaultAccessToken: string, dataEncryptionKey: EncryptionKey) {
    const result = await this.vaultAPIFactory(vaultAccessToken).ItemApi.itemsIdGet(id);
    const { item, thumbnails, attachments } = result;
    const slots = await ItemService.decryptAllSlots(result.slots, dataEncryptionKey);

    return ItemConfig.encodeFromJson({
      ...item,
      slots,
      thumbnails,
      attachments
    });
  }

  private async encryptSlot(slot: LocalSlot, dek: EncryptionKey) {
    const encrypted: any = {
      ...slot
    };
    encrypted.encrypted_value = await encryptWithKey({
      strategy: CipherStrategy.AES_GCM,
      key: dek.key,
      data: slot.value || ''
    }).then(result => result.serialized);
    delete encrypted.value;
    encrypted.encrypted = true;
    return encrypted;
  }

  public async list(vaultAccessToken: string) {
    const result = await this.vaultAPIFactory(vaultAccessToken).ItemApi.itemsGet();
    return ItemListConfig.encodeFromJson(result);
  }
}
