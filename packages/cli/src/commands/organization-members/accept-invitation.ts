import { OrganizationMembersService } from '@meeco/sdk';
import { flags as _flags } from '@oclif/command';
import { AuthConfig } from '../../configs/auth-config';
import { ConnectionV2Config } from '../../configs/connection-v2-config';
import { InvitationConfig } from '../../configs/invitation-config';
import { authFlags } from '../../flags/auth-flags';
import MeecoCommand from '../../util/meeco-command';

export default class OrganizationMembersAcceptInvitation extends MeecoCommand {
  static description = 'Accept Invitation to become organization member.';

  static examples = [
    `meeco organization-members:accpet-invitation -i .my-member-invitation.yaml -a .user_2.yaml > .my-org-member-connection.yaml`
  ];

  static flags = {
    ...MeecoCommand.flags,
    ...authFlags,
    invitationConfig: _flags.string({
      char: 'i',
      required: true,
      description: 'member invitation yaml file'
    })
  };

  async run() {
    const { flags } = this.parse(this.constructor as typeof OrganizationMembersAcceptInvitation);
    const { invitationConfig, auth } = flags;
    const environment = await this.readEnvironmentFile();
    const authConfig = await this.readConfigFromFile(AuthConfig, auth);
    const invitatioinConfigFile = await this.readConfigFromFile(InvitationConfig, invitationConfig);

    if (!authConfig) {
      this.error('Valid auth config file must be supplied');
    }
    if (!invitatioinConfigFile) {
      this.error('Valid organization config file must be supplied');
    }

    const { invitation } = invitatioinConfigFile;

    if (!invitation.token) {
      this.error('Organization configuration must have an token (expected at spec.token)');
    }
    try {
      this.updateStatus('Creating organization members connection');
      const service = new OrganizationMembersService(environment, this.updateStatus);
      const result = await service.acceptInvite(authConfig!.vault_access_token, invitation.token);
      this.finish();
      this.printYaml(
        ConnectionV2Config.encodeFromJSON(result.connection, {
          privateKey: result.privateKey,
          publicKey: result.publicKey
        })
      );
    } catch (err) {
      await this.handleException(err);
    }
  }
}
