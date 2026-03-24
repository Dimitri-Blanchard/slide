import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { servers, teams as teamsApi, webhooks as webhooksApi, BACKEND_ORIGIN } from '../api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useNotification } from '../context/NotificationContext';
import Avatar, { AvatarImg } from './Avatar';
import ColorPicker from './ColorPicker';
import ConfirmModal from './ConfirmModal';
import CommunitySetupWizard from './CommunitySetupWizard';
import './ServerSettings.css';

function parseDiscoveryTags(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v) || []; } catch { return []; }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════════════════
const OverviewTab = ({ team, onUpdate, onDirtyChange }) => {
  const [name, setName] = useState(team?.name || '');
  const [description, setDescription] = useState(team?.description || '');
  const [isPublic, setIsPublic] = useState(!!team?.is_public);
  const [discoveryTags, setDiscoveryTags] = useState(() => parseDiscoveryTags(team?.discovery_tags));
  const [discoveryBlurb, setDiscoveryBlurb] = useState(team?.discovery_blurb || '');
  const [verificationLevel, setVerificationLevel] = useState(team?.verification_level || 'none');
  const [defaultNotifications, setDefaultNotifications] = useState(team?.default_notifications || 'all');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [showCommunityWizard, setShowCommunityWizard] = useState(false);
  const iconInputRef = React.useRef(null);
  const savedBaselineRef = React.useRef(null);
  const { notify } = useNotification();

  const tagsEqual = useMemo(() => {
    const t = parseDiscoveryTags(team?.discovery_tags);
    return t.length === discoveryTags.length && t.every((x, i) => x === discoveryTags[i]);
  }, [team?.discovery_tags, discoveryTags]);

  // Normalize for comparison (MySQL returns is_public as 0/1, not boolean)
  const teamIsPublic = !!team?.is_public;
  const teamBlurb = (team?.discovery_blurb || '').trim();

  const hasChanges = name !== (team?.name || '') ||
    description !== (team?.description || '') ||
    isPublic !== teamIsPublic ||
    !tagsEqual ||
    discoveryBlurb.trim() !== teamBlurb ||
    verificationLevel !== (team?.verification_level || 'none') ||
    defaultNotifications !== (team?.default_notifications || 'all');

  useEffect(() => {
    // After save, suppress one effect run to avoid overwriting onDirtyChange(false) with stale hasChanges
    if (savedBaselineRef.current) {
      savedBaselineRef.current = null;
      onDirtyChange?.(false);
      return;
    }
    onDirtyChange?.(hasChanges);
  }, [hasChanges, onDirtyChange]);

  useEffect(() => {
    if (team?.id) {
      setDiscoveryTags(parseDiscoveryTags(team.discovery_tags));
      setDiscoveryBlurb(team.discovery_blurb || '');
    }
  }, [team?.id, team?.discovery_tags, team?.discovery_blurb]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await servers.updateSettings(team.id, {
        name, description, is_public: isPublic,
        verification_level: verificationLevel,
        default_notifications: defaultNotifications,
        discovery_tags: discoveryTags.length ? discoveryTags : null,
        discovery_blurb: discoveryBlurb.trim() || null
      });
      onUpdate?.(updated);
      savedBaselineRef.current = true;
      onDirtyChange?.(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      notify.error(err.message || 'Failed to save');
    }
    setSaving(false);
  };

  const handleIconClick = () => iconInputRef.current?.click();
  const handleIconChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) {
      notify.error('Please select a JPG, PNG, GIF or WebP image (max 8 MB)');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      notify.error('Image too large. Max 8 MB.');
      return;
    }
    setUploadingIcon(true);
    try {
      const result = await servers.uploadAvatar(team.id, file);
      onUpdate?.(result?.team);
      notify.success('Server icon updated');
    } catch (err) {
      notify.error(err.message || 'Failed to upload');
    }
    setUploadingIcon(false);
    e.target.value = '';
  };

  const resetAll = () => {
    setName(team?.name || '');
    setDescription(team?.description || '');
    setIsPublic(!!team?.is_public);
    setDiscoveryTags(parseDiscoveryTags(team?.discovery_tags));
    setDiscoveryBlurb(team?.discovery_blurb || '');
    setVerificationLevel(team?.verification_level || 'none');
    setDefaultNotifications(team?.default_notifications || 'all');
  };

  const handleCommunityToggle = () => {
    if (isPublic) {
      setIsPublic(false);
    } else {
      setShowCommunityWizard(true);
    }
  };

  const handleCommunityWizardComplete = async (data) => {
    setDiscoveryTags(data.discovery_tags || []);
    setDiscoveryBlurb(data.discovery_blurb || '');
    setIsPublic(true);
    setShowCommunityWizard(false);
    setSaving(true);
    try {
      const updated = await servers.updateSettings(team.id, {
        is_public: true,
        discovery_tags: (data.discovery_tags || []).length ? data.discovery_tags : null,
        discovery_blurb: (data.discovery_blurb || '').trim() || null
      });
      onUpdate?.(updated);
      savedBaselineRef.current = true;
      onDirtyChange?.(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      notify.success('Your server is now discoverable!');
    } catch (err) {
      notify.error(err.message || 'Failed to save');
      setIsPublic(false);
    }
    setSaving(false);
  };

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Server Overview</h2>

      <div className="ss-overview-top">
        <div className="ss-server-icon-area">
          <input
            ref={iconInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="ss-icon-input-hidden"
            onChange={handleIconChange}
          />
          <div
            className={`ss-server-icon-preview ${uploadingIcon ? 'uploading' : ''}`}
            onClick={handleIconClick}
            title="Click to upload new icon"
          >
            {uploadingIcon ? (
              <span className="ss-icon-upload-spinner" />
            ) : team?.avatar_url ? (
              <AvatarImg src={team.avatar_url} alt={team.name} />
            ) : (
              <span>{(name || '?').charAt(0).toUpperCase()}</span>
            )}
            {!uploadingIcon && (
              <div className="ss-icon-upload-overlay">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                </svg>
                <span>Change</span>
              </div>
            )}
          </div>
          <span className="ss-icon-hint">Click to upload (512×512 recommended, max 8 MB)</span>
        </div>

        <div className="ss-overview-fields">
          <div className="ss-field">
            <label>Server Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
        </div>
      </div>

      <div className="ss-field">
        <label>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell people about your server" rows={4} maxLength={1000} />
        <span className="ss-field-counter">{(description || '').length}/1000</span>
      </div>

      <div className="ss-divider" />

      <div className="ss-field">
        <label>Verification Level</label>
        <p className="ss-field-desc">Members must meet the following criteria before they can send messages.</p>
        <div className="ss-radio-group">
          {[
            { value: 'none', label: 'None', desc: 'Unrestricted' },
            { value: 'low', label: 'Low', desc: 'Must have a verified email' },
            { value: 'medium', label: 'Medium', desc: 'Must also be a member for longer than 5 minutes' },
            { value: 'high', label: 'High', desc: 'Must also be a member for longer than 10 minutes' },
          ].map(opt => (
            <label
              key={opt.value}
              className={`ss-radio-option ${verificationLevel === opt.value ? 'active' : ''}`}
              onClick={() => setVerificationLevel(opt.value)}
            >
              <input
                type="radio"
                name="verification"
                value={opt.value}
                checked={verificationLevel === opt.value}
                onChange={(e) => setVerificationLevel(e.target.value)}
                className="ss-radio-input"
                readOnly
              />
              <div>
                <span className="ss-radio-label">{opt.label}</span>
                <span className="ss-radio-desc">{opt.desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="ss-field">
        <label>Default Notification Settings</label>
        <div className="ss-radio-group horizontal">
          <label
            className={`ss-radio-option ${defaultNotifications === 'all' ? 'active' : ''}`}
            onClick={() => setDefaultNotifications('all')}
          >
            <input type="radio" name="notif" value="all" checked={defaultNotifications === 'all'} readOnly className="ss-radio-input" />
            <span className="ss-radio-label">All Messages</span>
          </label>
          <label
            className={`ss-radio-option ${defaultNotifications === 'mentions' ? 'active' : ''}`}
            onClick={() => setDefaultNotifications('mentions')}
          >
            <input type="radio" name="notif" value="mentions" checked={defaultNotifications === 'mentions'} readOnly className="ss-radio-input" />
            <span className="ss-radio-label">Only @mentions</span>
          </label>
        </div>
      </div>

      <div className="ss-toggle-field">
        <div>
          <span className="ss-toggle-label">Community Server</span>
          <span className="ss-toggle-desc">Make your server publicly discoverable</span>
        </div>
        <div className={`ss-toggle ${isPublic ? 'on' : ''}`} onClick={handleCommunityToggle}>
          <div className="ss-toggle-knob" />
        </div>
      </div>

      {showCommunityWizard && (
        <CommunitySetupWizard
          team={{ ...team, discovery_tags: discoveryTags, discovery_blurb: discoveryBlurb }}
          onComplete={handleCommunityWizardComplete}
          onCancel={() => setShowCommunityWizard(false)}
        />
      )}

      {hasChanges && (
        <div className="ss-save-bar">
          <span>Careful — you have unsaved changes!</span>
          <div className="ss-save-actions">
            <button className="ss-btn-reset" onClick={resetAll}>
              Reset
            </button>
            <button className="ss-btn-save" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// ROLES TAB - Full Discord-like role editor
// ═══════════════════════════════════════════════════════════
const PERMISSION_GROUPS = [
  {
    name: 'General Server Permissions',
    permissions: [
      { key: 'perm_administrator', label: 'Administrator', desc: 'Members with this permission have every permission and can bypass channel-specific overrides.', danger: true },
      { key: 'perm_manage_server', label: 'Manage Server', desc: 'Allows members to change the server name, icon, and other settings.' },
      { key: 'perm_manage_roles', label: 'Manage Roles', desc: 'Allows members to create, edit, and delete roles lower than their highest role.' },
      { key: 'perm_manage_channels', label: 'Manage Channels', desc: 'Allows members to create, edit, and delete channels.' },
      { key: 'perm_manage_emojis', label: 'Manage Emojis & Stickers', desc: 'Allows members to add or remove custom emojis and stickers.' },
      { key: 'perm_view_audit_log', label: 'View Audit Log', desc: 'Allows members to view changes to the server.' },
      { key: 'perm_manage_webhooks', label: 'Manage Webhooks', desc: 'Allows members to create, edit, and delete webhooks.' },
    ]
  },
  {
    name: 'Membership Permissions',
    permissions: [
      { key: 'perm_create_invites', label: 'Create Invite', desc: 'Allows members to invite new people to the server.' },
      { key: 'perm_change_nickname', label: 'Change Nickname', desc: 'Allows members to change their own nickname.' },
      { key: 'perm_manage_nicknames', label: 'Manage Nicknames', desc: 'Allows members to change nicknames of other members.' },
      { key: 'perm_kick_members', label: 'Kick Members', desc: 'Allows members to remove other members from the server.' },
      { key: 'perm_ban_members', label: 'Ban Members', desc: 'Allows members to permanently ban other members from the server.' },
    ]
  },
  {
    name: 'Text Channel Permissions',
    permissions: [
      { key: 'perm_send_messages', label: 'Send Messages', desc: 'Allows members to send messages in text channels.' },
      { key: 'perm_send_tts', label: 'Send TTS Messages', desc: 'Allows members to send text-to-speech messages.' },
      { key: 'perm_manage_messages', label: 'Manage Messages', desc: 'Allows members to delete messages by other members or pin messages.' },
      { key: 'perm_embed_links', label: 'Embed Links', desc: 'Allows links sent by members to show embedded content.' },
      { key: 'perm_attach_files', label: 'Attach Files', desc: 'Allows members to upload files or media in text channels.' },
      { key: 'perm_read_history', label: 'Read Message History', desc: 'Allows members to read previous messages.' },
      { key: 'perm_mention_everyone', label: 'Mention @everyone, @here, and All Roles', desc: 'Allows members to use @everyone or @here in messages.' },
      { key: 'perm_use_external_emojis', label: 'Use External Emojis', desc: 'Allows members to use emojis from other servers.' },
      { key: 'perm_add_reactions', label: 'Add Reactions', desc: 'Allows members to add reactions to messages.' },
    ]
  },
  {
    name: 'Voice Channel Permissions',
    permissions: [
      { key: 'perm_connect_voice', label: 'Connect', desc: 'Allows members to join voice channels.' },
      { key: 'perm_speak', label: 'Speak', desc: 'Allows members to talk in voice channels.' },
      { key: 'perm_mute_members', label: 'Mute Members', desc: 'Allows members to mute other members in voice channels.' },
      { key: 'perm_deafen_members', label: 'Deafen Members', desc: 'Allows members to deafen other members in voice channels.' },
      { key: 'perm_move_members', label: 'Move Members', desc: 'Allows members to move other members between voice channels.' },
      { key: 'perm_use_voice_activity', label: 'Use Voice Activity', desc: 'Allows members to speak without Push to Talk.' },
      { key: 'perm_priority_speaker', label: 'Priority Speaker', desc: 'Allows members to be more easily heard in voice channels.' },
      { key: 'perm_stream', label: 'Video', desc: 'Allows members to share video or screen in voice channels.' },
    ]
  }
];

const COLOR_PRESETS = [
  '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63',
  '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b',
  '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457',
  '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a',
];

// ── RoleMembersTab: list/add/remove members for a specific role ──────────────
const RoleMembersTab = ({ team, role, allMembers }) => {
  const { user: currentUser } = useAuth();
  const [roleMembers, setRoleMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addSearch, setAddSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const { notify } = useNotification();
  const addInputRef = useRef(null);

  useEffect(() => {
    if (!role) return;
    setLoading(true);
    servers.getRoleMembers(team.id, role.id)
      .then(data => setRoleMembers(data || []))
      .catch(() => notify.error('Failed to load role members'))
      .finally(() => setLoading(false));
  }, [team.id, role?.id]);

  const handleAdd = async (member) => {
    try {
      await servers.addMemberRole(team.id, member.id, role.id);
      setRoleMembers(prev => [...prev, { ...member, team_role: member.role }]);
      setAddSearch('');
      notify.success(`${member.display_name} ${role.name}`);
    } catch (err) { notify.error(err.message || 'Failed to add role'); }
  };

  const handleRemove = async (userId, displayName) => {
    try {
      await servers.removeMemberRole(team.id, userId, role.id);
      setRoleMembers(prev => prev.filter(m => m.id !== userId));
      notify.success(`Role removed from ${displayName}`);
    } catch (err) { notify.error(err.message || 'Failed to remove role'); }
  };

  const roleMemberIds = new Set(roleMembers.map(m => m.id));
  const filteredExisting = search.trim()
    ? roleMembers.filter(m => (m.display_name + m.username).toLowerCase().includes(search.toLowerCase()))
    : roleMembers;

  const addable = allMembers.filter(m =>
    !roleMemberIds.has(m.id) &&
    (!addSearch.trim() || (m.display_name + m.username).toLowerCase().includes(addSearch.toLowerCase()))
  );

  if (loading) return <div className="ss-rmt-empty">Loading members...</div>;

  return (
    <div className="ss-role-members">
      <div className="ss-rmt-header">
        <input
          type="text"
          className="ss-rmt-search"
          placeholder="Search members with this role..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className={`ss-rmt-add-btn ${showAdd ? 'active' : ''}`}
          type="button"
          onClick={() => { setShowAdd(v => !v); setAddSearch(''); setTimeout(() => addInputRef.current?.focus(), 50); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
          Add Member
        </button>
      </div>

      {showAdd && (
        <div className="ss-rmt-add-panel">
          <input
            ref={addInputRef}
            type="text"
            className="ss-rmt-search"
            placeholder="Search members to add..."
            value={addSearch}
            onChange={e => setAddSearch(e.target.value)}
          />
          <div className="ss-rmt-add-list">
            {addable.length === 0 ? (
              <div className="ss-rmt-empty">{addSearch ? 'No match' : 'All members already have this role'}</div>
            ) : addable.slice(0, 20).map(m => (
              <button
                key={m.id}
                type="button"
                className="ss-rmt-add-item"
                onClick={() => handleAdd(m)}
              >
                {m.avatar_url
                  ? <AvatarImg src={m.avatar_url} className="ss-rmt-avatar" alt="" />
                  : <span className="ss-rmt-avatar-fb">{(m.display_name || m.username || '?')[0].toUpperCase()}</span>
                }
                <div className="ss-rmt-info">
                  <span className="ss-rmt-name">{m.display_name}</span>
                  {m.username && <span className="ss-rmt-uname">@{m.username}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {filteredExisting.length === 0 ? (
        <div className="ss-rmt-empty">
          {search ? 'No members match your search.' : `No members have the "${role.name}" role yet.`}
        </div>
      ) : (
        <div className="ss-rmt-list">
          {filteredExisting.map(m => (
            <div key={m.id} className="ss-rmt-row">
              {m.avatar_url
                ? <AvatarImg src={m.avatar_url} className="ss-rmt-avatar" alt="" />
                : <span className="ss-rmt-avatar-fb">{(m.display_name || m.username || '?')[0].toUpperCase()}</span>
              }
              <div className="ss-rmt-info">
                <span className="ss-rmt-name">{m.display_name}</span>
                {m.username && <span className="ss-rmt-uname">@{m.username}</span>}
              </div>
              {m.team_role !== 'owner' && (
                <button
                  type="button"
                  className="ss-rmt-remove"
                  onClick={() => handleRemove(m.id, m.display_name)}
                  title="Remove this role"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const RolesTab = ({ team, initialRoles }) => {
  const [roles, setRoles] = useState(initialRoles || []);
  const [selectedRole, setSelectedRole] = useState(null);
  const [roleFilter, setRoleFilter] = useState('');
  const [loading, setLoading] = useState(!initialRoles);
  const [roleTab, setRoleTab] = useState('display');
  const [allMembers, setAllMembers] = useState([]);
  const { notify } = useNotification();

  const loadRoles = useCallback(async () => {
    try {
      const [rolesData, membersData] = await Promise.all([
        servers.getRoles(team.id),
        teamsApi.members(team.id),
      ]);
      setRoles(rolesData || []);
      setAllMembers(membersData || []);
      if (rolesData?.length > 0 && !selectedRole) setSelectedRole(rolesData[0]);
    } catch (err) { console.error(err); }
    setLoading(false);
  }, [team.id, selectedRole]);

  useEffect(() => {
    if (initialRoles) {
      setRoles(initialRoles);
      if (initialRoles.length > 0 && !selectedRole) setSelectedRole(initialRoles[0]);
      // Still fetch members for the Members tab
      teamsApi.members(team.id).then(d => setAllMembers(d || [])).catch(console.error);
    } else {
      loadRoles();
    }
  }, [initialRoles]);

  const handleCreateRole = async () => {
    try {
      const role = await servers.createRole(team.id, { name: 'new role' });
      setRoles([...roles, role]);
      setSelectedRole(role);
    } catch (err) { notify.error(err.message || 'Failed to create role'); }
  };

  const handleUpdateRole = async (field, value) => {
    if (!selectedRole) return;
    try {
      await servers.updateRole(team.id, selectedRole.id, { [field]: value });
      const updated = { ...selectedRole, [field]: value };
      setRoles(roles.map(r => r.id === selectedRole.id ? updated : r));
      setSelectedRole(updated);
    } catch (err) { notify.error(err.message || 'Failed to update role'); }
  };

  const handleDeleteRole = async () => {
    if (!selectedRole || selectedRole.is_default) return;
    try {
      await servers.deleteRole(team.id, selectedRole.id);
      const newRoles = roles.filter(r => r.id !== selectedRole.id);
      setRoles(newRoles);
      setSelectedRole(newRoles[0] || null);
    } catch (err) { notify.error(err.message || 'Failed to delete role'); }
  };

  if (loading) {
    return <div className="ss-tab-content"><div className="ss-loading">Loading roles...</div></div>;
  }

  return (
    <div className="ss-tab-content ss-roles-layout">
      {/* Role List Sidebar */}
      <div className="ss-roles-sidebar">
        <div className="ss-roles-header">
          <span className="ss-roles-count">Roles — {roles.length}</span>
          <button className="ss-btn-create-role" onClick={handleCreateRole}>Create Role</button>
        </div>
        <div className="ss-roles-search">
          <input type="text" placeholder="Search Roles" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} />
        </div>
        <div className="ss-roles-list">
          {roles.filter(r => !roleFilter.trim() || r.name.toLowerCase().includes(roleFilter.toLowerCase())).map(role => (
            <button key={role.id} className={`ss-role-item ${selectedRole?.id === role.id ? 'active' : ''}`} onClick={() => { setSelectedRole(role); setRoleTab('display'); }}>
              <span className="ss-role-dot" style={{ backgroundColor: role.color || '#99aab5' }} />
              <span className="ss-role-name">{role.name}</span>
              <span className="ss-role-count">{role.member_count || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Role Editor */}
      {selectedRole && (
        <div className="ss-role-editor">
          <div className="ss-role-editor-header">
            <h3>Edit Role — {selectedRole.name}</h3>
            {!selectedRole.is_default && (
              <button className="ss-btn-delete-role" onClick={handleDeleteRole}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>
            )}
          </div>

          {/* Role sub-tabs */}
          <div className="ss-role-tabs">
            <button className={roleTab === 'display' ? 'active' : ''} onClick={() => setRoleTab('display')}>Display</button>
            <button className={roleTab === 'permissions' ? 'active' : ''} onClick={() => setRoleTab('permissions')}>Permissions</button>
            <button className={roleTab === 'members' ? 'active' : ''} onClick={() => setRoleTab('members')}>
              Members
              {selectedRole?.member_count > 0 && (
                <span className="ss-role-tab-count">{selectedRole.member_count}</span>
              )}
            </button>
          </div>

          {roleTab === 'display' && (
            <div className="ss-role-display">
              <div className="ss-field">
                <label>Role Name</label>
                <input type="text" value={selectedRole.name} onChange={(e) => handleUpdateRole('name', e.target.value)} />
              </div>

              <div className="ss-field">
                <label>Role Color</label>
                <div className="ss-color-picker">
                  <div className="ss-color-presets">
                    {COLOR_PRESETS.map(color => (
                      <button key={color} className={`ss-color-swatch ${selectedRole.color === color ? 'active' : ''}`} style={{ backgroundColor: color }} onClick={() => handleUpdateRole('color', color)} />
                    ))}
                  </div>
                  <div className="ss-color-custom">
                    <ColorPicker value={selectedRole.color || '#99aab5'} onChange={(v) => handleUpdateRole('color', v)} />
                    <input type="text" value={selectedRole.color || '#99aab5'} onChange={(e) => handleUpdateRole('color', e.target.value)} className="ss-color-hex" />
                  </div>
                </div>
              </div>

              <div className="ss-divider" />

              <div className="ss-toggle-field">
                <div>
                  <span className="ss-toggle-label">Display role members separately</span>
                  <span className="ss-toggle-desc">Show members with this role in a separate section of the member list</span>
                </div>
                <div className={`ss-toggle ${selectedRole.show_separately ? 'on' : ''}`} onClick={() => handleUpdateRole('show_separately', !selectedRole.show_separately)}>
                  <div className="ss-toggle-knob" />
                </div>
              </div>

              <div className="ss-toggle-field">
                <div>
                  <span className="ss-toggle-label">Allow anyone to @mention this role</span>
                  <span className="ss-toggle-desc">Members can mention this role in messages</span>
                </div>
                <div className={`ss-toggle ${selectedRole.is_mentionable ? 'on' : ''}`} onClick={() => handleUpdateRole('is_mentionable', !selectedRole.is_mentionable)}>
                  <div className="ss-toggle-knob" />
                </div>
              </div>
            </div>
          )}

          {roleTab === 'permissions' && (
            <div className="ss-role-permissions">
              {PERMISSION_GROUPS.map(group => (
                <div key={group.name} className="ss-perm-group">
                  <h4 className="ss-perm-group-title">{group.name}</h4>
                  {group.permissions.map(perm => (
                    <div key={perm.key} className={`ss-perm-item ${perm.danger ? 'danger' : ''}`}>
                      <div className="ss-perm-info">
                        <span className="ss-perm-label">{perm.label}</span>
                        <span className="ss-perm-desc">{perm.desc}</span>
                      </div>
                      <div className={`ss-toggle ${selectedRole[perm.key] ? 'on' : ''}`} onClick={() => handleUpdateRole(perm.key, !selectedRole[perm.key])}>
                        <div className="ss-toggle-knob" />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {roleTab === 'members' && (
            <RoleMembersTab
              team={team}
              role={selectedRole}
              allMembers={allMembers}
            />
          )}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// EMOJI TAB
// ═══════════════════════════════════════════════════════════
const EmojiTab = ({ team }) => {
  const [emojis, setEmojis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newEmojiName, setNewEmojiName] = useState('');
  const [newEmojiUrl, setNewEmojiUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const emojiFileRef = React.useRef(null);
  const { notify } = useNotification();

  useEffect(() => {
    servers.getEmojis(team.id).then(data => setEmojis(data || [])).catch(console.error).finally(() => setLoading(false));
  }, [team.id]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) {
      notify.error('Please select a JPG, PNG, GIF or WebP image (max 256 KB)');
      return;
    }
    setUploading(true);
    try {
      const imageUrl = await servers.uploadEmojiImage(team.id, file);
      setNewEmojiUrl(imageUrl);
      if (!newEmojiName.trim()) {
        const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'emoji';
        setNewEmojiName(base);
      }
    } catch (err) { notify.error(err.message || 'Upload failed'); }
    setUploading(false);
    e.target.value = '';
  };

  const handleCreate = async () => {
    if (!newEmojiName.trim() || !newEmojiUrl.trim()) {
      notify.error('Name and image are required');
      return;
    }
    try {
      const emoji = await servers.createEmoji(team.id, { name: newEmojiName.trim(), image_url: newEmojiUrl.trim() });
      setEmojis([...emojis, emoji]);
      setNewEmojiName('');
      setNewEmojiUrl('');
    } catch (err) { notify.error(err.message || 'Failed to create emoji'); }
  };

  const handleDelete = async (emojiId) => {
    try {
      await servers.deleteEmoji(team.id, emojiId);
      setEmojis(emojis.filter(e => e.id !== emojiId));
    } catch (err) { notify.error(err.message || 'Failed to delete emoji'); }
  };

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Emojis</h2>
      <p className="ss-tab-desc">Add custom emojis that anyone in this server can use. Emojis must be under 256KB.</p>

      <div className="ss-emoji-upload">
        <input
          ref={emojiFileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="ss-icon-input-hidden"
          onChange={handleFileSelect}
        />
        <div className="ss-field">
          <label>Name</label>
          <input type="text" value={newEmojiName} onChange={(e) => setNewEmojiName(e.target.value)} placeholder="emoji_name" />
        </div>
        <div className="ss-field ss-emoji-url-row">
          <label>Image (upload or URL)</label>
          <div className="ss-emoji-image-inputs">
            <button type="button" className="ss-btn-upload-emoji" onClick={() => emojiFileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading...' : 'Upload file'}
            </button>
            <input type="text" value={newEmojiUrl} onChange={(e) => setNewEmojiUrl(e.target.value)} placeholder="https://... or upload" />
          </div>
        </div>
        <button className="ss-btn-save" onClick={handleCreate} disabled={!newEmojiName.trim() || !newEmojiUrl.trim()}>Add emoji</button>
      </div>

      <div className="ss-divider" />

      <div className="ss-emoji-stats">
        <span>{emojis.length} / 50 slots used</span>
      </div>

      {loading ? (
        <div className="ss-loading">Loading emojis...</div>
      ) : emojis.length === 0 ? (
        <div className="ss-empty">No custom emojis yet. Upload one above!</div>
      ) : (
        <div className="ss-emoji-grid">
          {emojis.map(emoji => (
            <div key={emoji.id} className="ss-emoji-item">
              <img src={emoji.image_url} alt={emoji.name} className="ss-emoji-img" />
              <span className="ss-emoji-name">:{emoji.name}:</span>
              <button className="ss-emoji-delete" onClick={() => handleDelete(emoji.id)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// MEMBERS TAB
// ═══════════════════════════════════════════════════════════
const MembersTab = ({ team, roles }) => {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [banTarget, setBanTarget] = useState(null);
  const [banReason, setBanReason] = useState('');
  const { notify } = useNotification();

  useEffect(() => {
    teamsApi.members(team.id).then(data => setMembers(data || [])).catch(console.error).finally(() => setLoading(false));
  }, [team.id]);

  const filteredMembers = useMemo(() => {
    if (!search.trim()) return members;
    const q = search.toLowerCase();
    return members.filter(m =>
      m.display_name?.toLowerCase().includes(q) || m.username?.toLowerCase().includes(q)
    );
  }, [members, search]);

  const handleKick = async (userId) => {
    try {
      await servers.kickMember(team.id, userId);
      setMembers(members.filter(m => m.id !== userId));
      notify.success('Member kicked');
    } catch (err) { notify.error(err.message || 'Failed to kick member'); }
  };

  const handleBanClick = (member) => setBanTarget(member);

  const handleBanConfirm = async () => {
    if (!banTarget) return;
    try {
      await servers.banMember(team.id, banTarget.id, { reason: banReason.trim() || undefined });
      setMembers(members.filter(m => m.id !== banTarget.id));
      setBanTarget(null);
      setBanReason('');
      notify.success('Member banned');
    } catch (err) { notify.error(err.message || 'Failed to ban'); }
  };

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Server Members</h2>
      <p className="ss-tab-desc">{members.length} Members</p>

      <div className="ss-members-filters">
        <input type="text" className="ss-members-search" placeholder="Search members" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? (
        <div className="ss-loading">Loading members...</div>
      ) : (
        <div className="ss-members-table">
          <div className="ss-members-table-header">
            <span className="ss-mt-name">Name</span>
            <span className="ss-mt-role">Role</span>
            <span className="ss-mt-joined">Joined</span>
            <span className="ss-mt-actions"></span>
          </div>
          {filteredMembers.map(member => (
            <div key={member.id} className="ss-members-row">
              <div className="ss-mt-name">
                <Avatar user={member} size="small" />
                <div>
                  <span className="ss-mt-display">{member.display_name}</span>
                  {member.username && <span className="ss-mt-username">@{member.username}</span>}
                </div>
              </div>
              <span className="ss-mt-role">
                {member.role === 'owner' ? (
                  <span className="ss-role-badge owner">Owner</span>
                ) : (
                  <span className="ss-role-badge">Member</span>
                )}
              </span>
              <span className="ss-mt-joined">
                {member.joined_at ? new Date(member.joined_at).toLocaleDateString() : '—'}
              </span>
              <div className="ss-mt-actions">
                {member.role !== 'owner' && (
                  <>
                    <button className="ss-mt-action" onClick={() => handleKick(member.id)} title="Kick">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
                    </button>
                    <button className="ss-mt-action danger" onClick={() => handleBanClick(member)} title="Ban">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {banTarget && (
        <div className="ss-ban-modal-overlay" onClick={() => { setBanTarget(null); setBanReason(''); }}>
          <div className="ss-ban-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Ban {banTarget.display_name}?</h3>
            <div className="ss-ban-modal-field">
              <label>Reason (optional)</label>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Enter reason for ban"
                maxLength={200}
              />
            </div>
            <div className="ss-ban-modal-actions">
              <button className="ss-btn-reset" onClick={() => { setBanTarget(null); setBanReason(''); }}>Cancel</button>
              <button className="ss-btn-ban-confirm" onClick={handleBanConfirm}>Ban</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// INVITES TAB
// ═══════════════════════════════════════════════════════════
const InvitesTab = ({ team }) => {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [maxAge, setMaxAge] = useState('24');
  const { notify } = useNotification();

  useEffect(() => {
    servers.getInvites(team.id).then(data => setInvites(data || [])).catch(console.error).finally(() => setLoading(false));
  }, [team.id]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const invite = await servers.createInvite(team.id, {
        maxUses: maxUses ? parseInt(maxUses) : null,
        maxAgeHours: maxAge ? parseInt(maxAge) : null,
      });
      setInvites([invite, ...invites]);
    } catch (err) { notify.error(err.message || 'Failed to create invite'); }
    setCreating(false);
  };

  const handleDelete = async (inviteId) => {
    try {
      await servers.deleteInvite(team.id, inviteId);
      setInvites(invites.filter(i => i.id !== inviteId));
    } catch (err) { notify.error(err.message || 'Failed to delete invite'); }
  };

  const copyInvite = (code) => {
    const text = `${window.location.origin}/invite/${code}`;
    navigator.clipboard?.writeText(text).then(() => notify.success('Copied!')).catch(() => {});
  };

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Invites</h2>

      <div className="ss-invite-create">
        <div className="ss-invite-options">
          <div className="ss-field inline">
            <label>Max Uses</label>
            <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
              <option value="">No limit</option>
              <option value="1">1 use</option>
              <option value="5">5 uses</option>
              <option value="10">10 uses</option>
              <option value="25">25 uses</option>
              <option value="50">50 uses</option>
              <option value="100">100 uses</option>
            </select>
          </div>
          <div className="ss-field inline">
            <label>Expire After</label>
            <select value={maxAge} onChange={(e) => setMaxAge(e.target.value)}>
              <option value="">Never</option>
              <option value="0.5">30 minutes</option>
              <option value="1">1 hour</option>
              <option value="6">6 hours</option>
              <option value="12">12 hours</option>
              <option value="24">1 day</option>
              <option value="168">7 days</option>
            </select>
          </div>
        </div>
        <button className="ss-btn-save" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating...' : 'Generate Invite Link'}
        </button>
      </div>

      <div className="ss-divider" />

      {loading ? (
        <div className="ss-loading">Loading invites...</div>
      ) : invites.length === 0 ? (
        <div className="ss-empty">No active invites</div>
      ) : (
        <div className="ss-invites-list">
          {invites.map(invite => (
            <div key={invite.id} className="ss-invite-item">
              <div className="ss-invite-info">
                <code className="ss-invite-code">{invite.code}</code>
                <span className="ss-invite-meta">
                  {invite.uses}/{invite.max_uses || '∞'} uses
                  {invite.expires_at && ` · Expires ${new Date(invite.expires_at).toLocaleDateString()}`}
                  {invite.created_by_name && ` · by ${invite.created_by_name}`}
                </span>
              </div>
              <div className="ss-invite-actions">
                <button className="ss-btn-icon" onClick={() => copyInvite(invite.code)} title="Copy">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                </button>
                <button className="ss-btn-icon danger" onClick={() => handleDelete(invite.id)} title="Delete">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// BANS TAB
// ═══════════════════════════════════════════════════════════
const BansTab = ({ team }) => {
  const [bans, setBans] = useState([]);
  const [loading, setLoading] = useState(true);
  const { notify } = useNotification();

  useEffect(() => {
    servers.getBans(team.id).then(data => setBans(data || [])).catch(console.error).finally(() => setLoading(false));
  }, [team.id]);

  const handleUnban = async (userId) => {
    try {
      await servers.unbanMember(team.id, userId);
      setBans(bans.filter(b => b.user_id !== userId));
      notify.success('Member unbanned');
    } catch (err) { notify.error(err.message || 'Failed to unban'); }
  };

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Bans</h2>
      <p className="ss-tab-desc">Members who have been banned from this server.</p>

      {loading ? (
        <div className="ss-loading">Loading bans...</div>
      ) : bans.length === 0 ? (
        <div className="ss-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          <span>No banned members</span>
        </div>
      ) : (
        <div className="ss-bans-list">
          {bans.map(ban => (
            <div key={ban.user_id} className="ss-ban-item">
              <Avatar user={{ display_name: ban.display_name, avatar_url: ban.avatar_url }} size="small" />
              <div className="ss-ban-info">
                <span className="ss-ban-name">{ban.display_name}</span>
                {ban.reason && <span className="ss-ban-reason">Reason: {ban.reason}</span>}
                <span className="ss-ban-date">Banned {new Date(ban.banned_at).toLocaleDateString()}</span>
              </div>
              <button className="ss-btn-unban" onClick={() => handleUnban(ban.user_id)}>Revoke Ban</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// AUDIT LOG TAB
// ═══════════════════════════════════════════════════════════
const AuditLogTab = ({ team }) => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    servers.getAuditLog(team.id, { limit: 100 }).then(data => setLogs(data || [])).catch(console.error).finally(() => setLoading(false));
  }, [team.id]);

  const actionLabels = {
    'ROLE_CREATE': 'created a role',
    'ROLE_UPDATE': 'updated a role',
    'ROLE_DELETE': 'deleted a role',
    'MEMBER_BAN': 'banned a member',
    'MEMBER_UNBAN': 'unbanned a member',
    'MEMBER_KICK': 'kicked a member',
    'MEMBER_UPDATE': 'updated a member',
    'MEMBER_ROLE_ADD': 'assigned a role to a member',
    'MEMBER_ROLE_REMOVE': 'removed a role from a member',
    'MEMBER_ROLE_DELETE': 'removed a role from a member',
    'CHANNEL_CREATE': 'created a channel',
    'CHANNEL_UPDATE': 'updated a channel',
    'CHANNEL_DELETE': 'deleted a channel',
    'CATEGORY_CREATE': 'created a category',
    'CATEGORY_UPDATE': 'updated a category',
    'CATEGORY_DELETE': 'deleted a category',
    'INVITE_CREATE': 'created an invite',
    'INVITE_DELETE': 'deleted an invite',
    'SERVER_UPDATE': 'updated server settings',
    'EMOJI_CREATE': 'added an emoji',
    'EMOJI_DELETE': 'removed an emoji',
    'WEBHOOK_CREATE': 'created a webhook',
    'WEBHOOK_UPDATE': 'updated a webhook',
    'WEBHOOK_DELETE': 'deleted a webhook',
  };

  const actionColors = {
    'MEMBER_BAN': 'red', 'MEMBER_KICK': 'red', 'CHANNEL_DELETE': 'red',
    'ROLE_DELETE': 'red', 'CATEGORY_DELETE': 'red', 'INVITE_DELETE': 'red',
    'EMOJI_DELETE': 'red', 'WEBHOOK_DELETE': 'red',
    'MEMBER_ROLE_REMOVE': 'red', 'MEMBER_ROLE_DELETE': 'red',
    'ROLE_CREATE': 'green', 'CHANNEL_CREATE': 'green', 'CATEGORY_CREATE': 'green',
    'INVITE_CREATE': 'green', 'EMOJI_CREATE': 'green', 'WEBHOOK_CREATE': 'green',
    'MEMBER_UNBAN': 'green', 'MEMBER_ROLE_ADD': 'green',
    'ROLE_UPDATE': 'blue', 'CHANNEL_UPDATE': 'blue', 'SERVER_UPDATE': 'blue',
    'CATEGORY_UPDATE': 'blue', 'MEMBER_UPDATE': 'blue', 'WEBHOOK_UPDATE': 'blue',
  };

  const actionSvgIcons = {
    'MEMBER_BAN': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>,
    'MEMBER_KICK': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>,
    'MEMBER_UNBAN': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>,
    'CHANNEL_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>,
    'CHANNEL_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
    'CHANNEL_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>,
    'ROLE_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>,
    'ROLE_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>,
    'ROLE_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z"/></svg>,
    'SERVER_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>,
    'INVITE_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>,
    'INVITE_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>,
    'EMOJI_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>,
    'EMOJI_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>,
    'MEMBER_ROLE_ADD': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>,
    'MEMBER_ROLE_REMOVE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>,
    'MEMBER_ROLE_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>,
    'MEMBER_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
    'CATEGORY_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>,
    'CATEGORY_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 7h-4v4h-2v-4h-4v-2h4V7h2v4h4v2z"/></svg>,
    'CATEGORY_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-4 9H8v-2h8v2z"/></svg>,
    'WEBHOOK_CREATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>,
    'WEBHOOK_UPDATE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
    'WEBHOOK_DELETE': <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>,
  };

  function formatRelativeTime(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  return (
    <div className="ss-tab-content">
      <h2 className="ss-tab-title">Audit Log</h2>
      <p className="ss-tab-desc">A log of all administrative actions on this server.</p>

      {loading ? (
        <div className="ss-loading">Loading audit log...</div>
      ) : logs.length === 0 ? (
        <div className="ss-empty">No audit log entries</div>
      ) : (
        <div className="ss-audit-list">
          {logs.map(log => {
            const color = actionColors[log.action_type] || 'blue';
            const svgIcon = actionSvgIcons[log.action_type];
            const isExpanded = expandedId === log.id;
            const actorInitial = (log.display_name || '?').charAt(0).toUpperCase();

            return (
              <div
                key={log.id}
                className={`ss-audit-card ss-audit-${color} ${isExpanded ? 'expanded' : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                {/* Collapsed row */}
                <div className="ss-audit-row">
                  <span className={`ss-audit-icon-badge ss-audit-icon-${color}`}>
                    {svgIcon || (color === 'red'
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      : color === 'green'
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    )}
                  </span>
                  <div className="ss-audit-content">
                    <div className="ss-audit-action">
                      <strong>{log.display_name}</strong> {actionLabels[log.action_type] || log.action_type}
                      {log.target_name && <span className="ss-audit-target"> · {log.target_name}</span>}
                    </div>
                  </div>
                  <div className="ss-audit-meta">
                    <span className="ss-audit-time" title={new Date(log.created_at).toLocaleString()}>
                      {formatRelativeTime(log.created_at)}
                    </span>
                    <svg className={`ss-audit-chevron ${isExpanded ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                    </svg>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="ss-audit-details">
                    <div className="ss-audit-actor">
                      {log.avatar_url ? (
                        <img src={log.avatar_url} alt={log.display_name} className="ss-audit-actor-avatar" />
                      ) : (
                        <div className="ss-audit-actor-avatar-fallback">{actorInitial}</div>
                      )}
                      <div>
                        <div className="ss-audit-actor-name">{log.display_name}</div>
                        {log.username && log.username !== log.display_name && (
                          <div className="ss-audit-actor-username">@{log.username}</div>
                        )}
                      </div>
                    </div>
                    <div className="ss-audit-detail-rows">
                      <div className="ss-audit-detail-row">
                        <span className="ss-audit-detail-label">Action</span>
                        <span className="ss-audit-detail-value">{actionLabels[log.action_type] || log.action_type}</span>
                      </div>
                      {log.target_name && (
                        <div className="ss-audit-detail-row">
                          <span className="ss-audit-detail-label">Target</span>
                          <span className="ss-audit-detail-value">{log.target_name}</span>
                        </div>
                      )}
                      {log.reason && (
                        <div className="ss-audit-detail-row">
                          <span className="ss-audit-detail-label">Reason</span>
                          <span className="ss-audit-detail-value ss-audit-detail-reason">{log.reason}</span>
                        </div>
                      )}
                      {log.changes && (
                        <div className="ss-audit-detail-row">
                          <span className="ss-audit-detail-label">Changes</span>
                          <span className="ss-audit-detail-value">{typeof log.changes === 'string' ? log.changes : JSON.stringify(log.changes, null, 2)}</span>
                        </div>
                      )}
                      <div className="ss-audit-detail-row">
                        <span className="ss-audit-detail-label">Time</span>
                        <span className="ss-audit-detail-value">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Webhook avatars: static profile pictures only (no GIF, banner, banner colors)
function isAllowedWebhookAvatarUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase().trim();
  if (u.includes('.gif') || u.includes('/gif')) return false;
  if (u.includes('/banners/') || u.includes('banner')) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(u)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════
// WEBHOOKS TAB
// ═══════════════════════════════════════════════════════════
const WebhooksTab = ({ team, channels }) => {
  const [webhookList, setWebhookList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newChannelId, setNewChannelId] = useState('');
  const [newAvatarFile, setNewAvatarFile] = useState(null);
  const [newAvatarPreview, setNewAvatarPreview] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editAvatarFile, setEditAvatarFile] = useState(null);
  const [editAvatarPreview, setEditAvatarPreview] = useState('');
  const newAvatarInputRef = useRef(null);
  const editAvatarInputRef = useRef(null);
  const { notify } = useNotification();

  const textChannels = (channels || []).filter(c => c.channel_type === 'text' || !c.channel_type);

  useEffect(() => {
    webhooksApi.list(team.id)
      .then(data => setWebhookList(data || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [team.id]);

  const handleNewAvatarChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      notify.error('Avatar must be PNG, JPG or WebP.');
      return;
    }
    setNewAvatarFile(file);
    setNewAvatarPreview(URL.createObjectURL(file));
    e.target.value = '';
  };

  const handleEditAvatarChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      notify.error('Avatar must be PNG, JPG or WebP.');
      return;
    }
    setEditAvatarFile(file);
    setEditAvatarPreview(URL.createObjectURL(file));
    e.target.value = '';
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || !newChannelId) return;
    setCreating(true);
    try {
      const wh = await webhooksApi.create(team.id, { name: newName.trim(), channelId: parseInt(newChannelId) });
      let created = wh;
      if (newAvatarFile) {
        try {
          const avatarResult = await webhooksApi.uploadAvatar(team.id, wh.id, newAvatarFile);
          created = { ...created, avatar_url: avatarResult.avatar_url };
        } catch (avatarErr) {
          notify.error('Webhook created but avatar upload failed: ' + (avatarErr.message || ''));
        }
      }
      setWebhookList([created, ...webhookList]);
      setNewName('');
      setNewChannelId('');
      if (newAvatarPreview) URL.revokeObjectURL(newAvatarPreview);
      setNewAvatarFile(null);
      setNewAvatarPreview('');
      setShowForm(false);
      notify.success('Webhook created');
    } catch (err) { notify.error(err.message || 'Failed to create webhook'); }
    setCreating(false);
  };

  const startEdit = (wh) => {
    setEditingId(wh.id);
    setEditName(wh.name || '');
    setEditAvatarFile(null);
    setEditAvatarPreview('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    if (editAvatarPreview) URL.revokeObjectURL(editAvatarPreview);
    setEditAvatarFile(null);
    setEditAvatarPreview('');
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editingId || !editName.trim()) return;
    try {
      const updated = await webhooksApi.update(team.id, editingId, { name: editName.trim() });
      let result = { ...updated };
      if (editAvatarFile) {
        try {
          const avatarResult = await webhooksApi.uploadAvatar(team.id, editingId, editAvatarFile);
          result.avatar_url = avatarResult.avatar_url;
        } catch (avatarErr) {
          notify.error('Name updated but avatar upload failed: ' + (avatarErr.message || ''));
        }
      }
      setWebhookList(webhookList.map(w => w.id === editingId ? { ...w, ...result } : w));
      cancelEdit();
      notify.success('Webhook updated');
    } catch (err) { notify.error(err.message || 'Failed to update webhook'); }
  };

  const handleDelete = async (wh) => {
    if (!window.confirm(`Delete webhook "${wh.name}"?`)) return;
    try {
      await webhooksApi.delete(team.id, wh.id);
      setWebhookList(webhookList.filter(w => w.id !== wh.id));
      notify.success('Webhook deleted');
    } catch (err) { notify.error(err.message || 'Failed to delete'); }
  };

  const handleRegenerate = async (wh) => {
    if (!window.confirm('Regenerate this webhook token? The old URL will stop working.')) return;
    try {
      const { token } = await webhooksApi.regenerateToken(team.id, wh.id);
      setWebhookList(webhookList.map(w => w.id === wh.id ? { ...w, token } : w));
      notify.success('Token regenerated');
    } catch (err) { notify.error(err.message || 'Failed to regenerate'); }
  };

  const getWebhookUrl = (wh) => `${BACKEND_ORIGIN}/api/webhooks/execute/${wh.token}`;

  const copyUrl = async (wh) => {
    const url = getWebhookUrl(wh);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(wh.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      notify.error('Failed to copy URL');
    }
  };

  return (
    <div className="ss-tab-content">
      <div className="ss-tab-header-row">
        <div>
          <h2 className="ss-tab-title">Webhooks</h2>
          <p className="ss-tab-desc">Use webhooks to post messages to channels automatically from external services.</p>
        </div>
        <button className="ss-btn-save" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Webhook'}
        </button>
      </div>

      {showForm && (
        <form className="ss-webhook-form" onSubmit={handleCreate}>
          <div className="ss-field">
            <label>Webhook Name</label>
            <input
              type="text" value={newName} maxLength={80} placeholder="e.g. GitHub Notifications"
              onChange={(e) => setNewName(e.target.value)} required
            />
          </div>
          <div className="ss-field">
            <label>Channel</label>
            <select value={newChannelId} onChange={(e) => setNewChannelId(e.target.value)} required>
              <option value="">Select a channel...</option>
              {textChannels.map(c => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </div>
          <div className="ss-field">
            <label>Avatar <span className="ss-field-hint">(optional — PNG, JPG or WebP only)</span></label>
            <input
              ref={newAvatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleNewAvatarChange}
              style={{ display: 'none' }}
            />
            <div className="ss-field-row" style={{ gap: '8px', alignItems: 'center' }}>
              {newAvatarPreview && <img src={newAvatarPreview} alt="Avatar preview" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />}
              <button type="button" className="ss-btn-ghost" onClick={() => newAvatarInputRef.current?.click()}>
                {newAvatarFile ? 'Change avatar' : 'Upload avatar'}
              </button>
              {newAvatarFile && (
                <button type="button" className="ss-btn-ghost" onClick={() => { if (newAvatarPreview) URL.revokeObjectURL(newAvatarPreview); setNewAvatarFile(null); setNewAvatarPreview(''); }}>
                  Remove
                </button>
              )}
            </div>
          </div>
          <div className="ss-field-row">
            <button type="submit" className="ss-btn-save" disabled={creating || !newName.trim() || !newChannelId}>
              {creating ? 'Creating...' : 'Create Webhook'}
            </button>
          </div>
        </form>
      )}

      <div className="ss-divider" />

      {loading ? (
        <div className="ss-loading">Loading webhooks...</div>
      ) : webhookList.length === 0 ? (
        <div className="ss-empty">No webhooks yet. Create one to get started.</div>
      ) : (
        <div className="ss-webhooks-list">
          {webhookList.map(wh => (
            <div key={wh.id} className="ss-webhook-item">
              {editingId === wh.id ? (
                <form className="ss-webhook-edit-form" onSubmit={handleUpdate}>
                  <div className="ss-field">
                    <label>Name</label>
                    <input type="text" value={editName} maxLength={80} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div className="ss-field">
                    <label>Avatar <span className="ss-field-hint">(PNG, JPG or WebP only)</span></label>
                    <input
                      ref={editAvatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleEditAvatarChange}
                      style={{ display: 'none' }}
                    />
                    <div className="ss-field-row" style={{ gap: '8px', alignItems: 'center' }}>
                      {editAvatarPreview && <img src={editAvatarPreview} alt="Avatar preview" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />}
                      <button type="button" className="ss-btn-ghost" onClick={() => editAvatarInputRef.current?.click()}>
                        {editAvatarFile ? 'Change avatar' : 'Upload avatar'}
                      </button>
                      {editAvatarFile && (
                        <button type="button" className="ss-btn-ghost" onClick={() => { if (editAvatarPreview) URL.revokeObjectURL(editAvatarPreview); setEditAvatarFile(null); setEditAvatarPreview(''); }}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="ss-field-row">
                    <button type="button" className="ss-btn-ghost" onClick={cancelEdit}>Cancel</button>
                    <button type="submit" className="ss-btn-save">Save</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="ss-webhook-info">
                    <div className="ss-webhook-name">{wh.name}</div>
                    <div className="ss-webhook-meta">
                      #{wh.channel_name} · by {wh.creator_name} · {new Date(wh.created_at).toLocaleDateString()}
                    </div>
                    <div className="ss-webhook-url-row">
                      <code className="ss-webhook-url">{getWebhookUrl(wh).replace(wh.token, wh.token.slice(0, 12) + '...')}</code>
                      <button className="ss-btn-icon" onClick={() => copyUrl(wh)} title="Copy URL">
                        {copiedId === wh.id ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="ss-webhook-actions">
                    <button className="ss-btn-icon" onClick={() => startEdit(wh)} title="Edit webhook">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <button className="ss-btn-icon" onClick={() => handleRegenerate(wh)} title="Regenerate token">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
                    </button>
                    <button className="ss-btn-icon danger" onClick={() => handleDelete(wh)} title="Delete webhook">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// MAIN SERVER SETTINGS COMPONENT
// ═══════════════════════════════════════════════════════════
export default function ServerSettings({ team, roles, members, channels, categories, isOpen, onClose, onUpdate }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const { t } = useLanguage();

  const handleClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowUnsavedConfirm(true);
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen || !team) return null;

  const navGroups = [
    {
      label: team.name,
      items: [
        { id: 'overview', label: 'Overview', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> },
        { id: 'roles', label: 'Roles', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg> },
        { id: 'emoji', label: 'Emoji', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg> },
        { id: 'members', label: 'Members', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg> },
        { id: 'webhooks', label: 'Webhooks', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg> },
      ]
    },
    {
      label: 'Moderation',
      items: [
        { id: 'invites', label: 'Invites', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg> },
        { id: 'bans', label: 'Bans', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg> },
        { id: 'audit', label: 'Audit Log', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg> },
      ]
    }
  ];

  const renderTab = () => {
    switch (activeTab) {
      case 'overview': return <OverviewTab team={team} onUpdate={onUpdate} onDirtyChange={setHasUnsavedChanges} />;
      case 'roles': return <RolesTab team={team} initialRoles={roles} />;
      case 'emoji': return <EmojiTab team={team} />;
      case 'members': return <MembersTab team={team} roles={roles} />;
      case 'invites': return <InvitesTab team={team} />;
      case 'bans': return <BansTab team={team} />;
      case 'audit': return <AuditLogTab team={team} />;
      case 'webhooks': return <WebhooksTab team={team} channels={channels} />;
      default: return null;
    }
  };

  return (
    <div className="ss-overlay">
      <div className="ss-layout">
        {/* Navigation Sidebar */}
        <div className="ss-nav">
          <div className="ss-nav-scroll">
            {navGroups.map(group => (
              <div key={group.label} className="ss-nav-group">
                <h3 className="ss-nav-group-title">{group.label}</h3>
                {group.items.map(item => (
                  <button
                    key={item.id}
                    className={`ss-nav-item ${activeTab === item.id ? 'active' : ''}`}
                    onClick={() => setActiveTab(item.id)}
                  >
                    <span className="ss-nav-icon">{item.icon}</span>
                    <span className="ss-nav-label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="ss-content">
          {renderTab()}
        </div>

        {/* Close Button */}
        <div className="ss-close-area">
          <button className="ss-close-btn" onClick={handleClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
          <span className="ss-close-hint">ESC</span>
        </div>
      </div>

      <ConfirmModal
        isOpen={showUnsavedConfirm}
        title="Unsaved Changes"
        message="You have unsaved changes. Are you sure you want to leave? Your changes will be lost."
        confirmText="Discard"
        cancelText="Keep Editing"
        type="danger"
        onConfirm={() => {
          setShowUnsavedConfirm(false);
          setHasUnsavedChanges(false);
          onClose();
        }}
        onCancel={() => setShowUnsavedConfirm(false)}
      />
    </div>
  );
}
