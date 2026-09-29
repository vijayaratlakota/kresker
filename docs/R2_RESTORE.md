# VoiceStudio Golden State — Cloudflare R2 Backup & Restore

**Backup date:** 24 August 2026
**Source:** EBS snapshot `snap-0c003e3c8bf8dab1f` of the golden box's root volume
**Original pipeline:** never touched. See "Why the original was safe" at the bottom.

---

## 1. Where the backup actually is

| | |
|---|---|
| Provider | Cloudflare R2 |
| Bucket | `voicestudio-golden` |
| Jurisdiction | APAC |
| Prefix (folder) | `golden-20260823/` |
| S3 endpoint | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| Credentials | `C:\Users\vijay\.secrets\r2.env` on your PC |
| Objects | 7 archives + `MANIFEST.txt` |
| Stored size | ~57.8 GiB (from 115 GB of source data) |
| Storage cost | ~$0.87/month (~₹73/month) |
| Egress cost | **zero** — downloads are free, forever |

Full path to one object, as an example:

```
r2:voicestudio-golden/golden-20260823/var-containerd.tar.zst
```

### The 7 archives

Each is a `tar` archive compressed with `zstd`. Together they contain **every one of the
24 top-level directories** on the golden disk — a coverage check confirmed zero entries
were left unclaimed.

| Object | Stored size | What's inside |
|---|---|---|
| `var-containerd.tar.zst` | 30.68 GB | `/var/lib/containerd` — **the pipeline itself.** Container image layers, including layer 24 which holds your hand-patched `app/backend` code |
| `var-docker.tar.zst` | 17.56 GB | `/var/lib/docker` — container metadata and the running container `9276383fe31e` |
| `usr.tar.zst` | 7.66 GB | `/usr` — NVIDIA drivers, CUDA userspace, system binaries |
| `opt.tar.zst` | 4.49 GB | `/opt` — AWS/DLAMI tooling |
| `var-rest.tar.zst` | 814 MB | `/var` minus the two big directories above — logs, caches, apt state |
| `system.tar.zst` | 798 MB | `/bin /boot /dev /etc /home /lib* /lost+found /media /mnt /proc /root /run /sbin /snap /srv /sys /tmp` |
| `swapfile.tar.zst` | 790 KB | The 24 GiB swapfile. It was almost entirely zeros, so it compressed 33,000:1 |

### Checksums

These are also in `golden-20260823/MANIFEST.txt` inside the bucket. Every one was
computed by reading the object back **out of** R2, and for six of the seven it was also
compared against the hash computed while uploading — all six matched exactly.

| Object | Bytes | SHA-256 |
|---|---|---|
| `var-containerd.tar.zst` | 30,677,299,783 | `9ae324995ff5d472c70c7077b3a7626acc7fcc833d209958db07e01ae2f5b7d3` |
| `var-docker.tar.zst` | 17,563,508,744 | `d6a4a6121d3b7324b8179eb76963d27d101af6b503d3f61a6032206903cfadf4` |
| `usr.tar.zst` | 7,662,497,108 | `3b529a722eee255332b116d5fda774048eef17b6a16e87729096503d7b58f39f` |
| `opt.tar.zst` | 4,485,410,553 | `3a3bd219fc16b43b6f0199e3d9775e04cccf6550c47308e9d5f683506189f478` |
| `var-rest.tar.zst` | 813,991,359 | `f9f531ab19e99cb5d3e74c56ce12f109f2244070790fa5349fb355c2dd6617a3` |
| `system.tar.zst` | 798,309,091 | `0f0ec15f7beea0989134597f7b7240bef6880717a552596757deb5cd84ddd81e` |
| `swapfile.tar.zst` | 808,205 | `534cd510bb44e3910fa861a81ffce084d5cddbbfd0cfa13f5d4f7bf11bd666f8` |

Total: **62,001,831,603 bytes (57.74 GiB)** across 8 objects including the manifest.

### What was actually verified

Not just "the upload finished". Four independent checks:

1. **Coverage** — all 24 top-level directories of the source disk are claimed by exactly
   one archive. Unclaimed: 0.
2. **Integrity** — every object was streamed back out of R2 and hashed. Six matched their
   send-side hash byte for byte.
3. **Structure** — archives were listed with `tar -tf` straight from R2, proving the zstd
   stream and tar structure are intact end to end, not merely present.
4. **The one that counts** — the patched pipeline files were *extracted back out of the R2
   copy* of `var-containerd.tar.zst` and re-checksummed. All seven golden fingerprints
   passed. The backup demonstrably contains the tuned pipeline, not just something
   shaped like it.

A local re-check from the Windows PC (no AWS involved) downloaded `swapfile.tar.zst` and
reproduced its SHA-256 exactly.

### What is deliberately *not* in the backup

- **`/boot/efi`** (the EFI boot partition). It's a separate vfat filesystem and `tar
  --one-file-system` did not cross into it. This is fine: the restore procedure below
  starts from a stock Ubuntu image that supplies its own working EFI partition and
  bootloader, and our `/boot/grub` files then take over.

---

## 2. Getting access to the bucket

Install [rclone](https://rclone.org/downloads/), then create a config file.
On Linux that's `~/.config/rclone/rclone.conf`; on Windows,
`%APPDATA%\rclone\rclone.conf`:

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET_ACCESS_KEY>
endpoint = https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
```

The three values come out of `C:\Users\vijay\.secrets\r2.env`.

Check it works:

```bash
rclone ls   r2:voicestudio-golden/golden-20260823/
rclone size r2:voicestudio-golden/golden-20260823/
rclone cat  r2:voicestudio-golden/golden-20260823/MANIFEST.txt
```

---

## 3. Restore — pick the path that matches your situation

### Path A: the AWS AMI still exists (fastest, minutes)

This is the normal case. R2 is the off-AWS insurance policy; the AMI is the quick route.

```powershell
aws ec2 run-instances --profile videotrans --region ap-south-1 `
  --image-id ami-09583800297a6f720 `
  --instance-type g4dn.xlarge `
  --key-name videotrans-key `
  --security-group-ids sg-0dfc3932e7d0896a4 `
  --iam-instance-profile Name=OmniVoiceTranslateRole `
  --block-device-mappings '[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":150,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":false}}]'
```

Wait about 4 minutes, SSH in, then run the verification in section 4.
This AMI has already been boot-tested: the container came back on its own, the hostname
`9276383fe31e` was preserved, all five MD5s matched, and the Gemini proxy minted a real
token.

### Path B: full rebuild from R2 (AMI gone, or moving to another cloud/account)

You cannot safely extract `system.tar.zst` onto a machine that is currently *booted from*
the disk you're overwriting — you'd be replacing `/etc` and libraries that are in use.
So we restore into a disk that is attached as a *secondary* volume, then boot from it.

**B1. Create the target disk from a stock Ubuntu 22.04 image.**
Launch a throwaway `t3.medium` from a stock Ubuntu 22.04 AMI with a 150 GiB root volume,
then immediately stop it. That volume now has the correct partition table, EFI partition
and GRUB. We're going to replace its filesystem contents.

**B2. Launch a helper instance** (`m5.large` or bigger — more network bandwidth means a
faster restore) from any Ubuntu 22.04 AMI.

**B3. Detach the target volume from the throwaway instance and attach it to the helper**
as `/dev/sdf`. It will appear as `/dev/nvme1n1` with one main partition
`/dev/nvme1n1p1`.

**B4. On the helper, prepare and fill the disk:**

```bash
sudo apt-get update && sudo apt-get install -y rclone zstd

# label must match /etc/fstab from the backup, which mounts root by LABEL
sudo e2label /dev/nvme1n1p1 cloudimg-rootfs

sudo mkdir -p /mnt/target
sudo mount /dev/nvme1n1p1 /mnt/target

# clear the stock filesystem contents, keeping the filesystem itself
sudo find /mnt/target -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# stream each archive straight from R2 into the disk - nothing is staged locally,
# so you don't need spare space for the 57 GB of archives
cd /mnt/target
for a in var-containerd var-docker usr opt var-rest system; do
  echo "restoring $a ..."
  sudo rclone cat "r2:voicestudio-golden/golden-20260823/${a}.tar.zst" \
    | sudo tar -I zstd --numeric-owner --xattrs --acls -xf - -C /mnt/target
done
```

**B5. Recreate the swapfile.** Restoring the 24 GiB original would mean writing 24 GiB of
zeros, so just make a fresh one — `/etc/fstab` already expects `/swapfile`:

```bash
sudo fallocate -l 24G /mnt/target/swapfile
sudo chmod 600 /mnt/target/swapfile
sudo mkswap /mnt/target/swapfile
```

**B6. Detach and boot.** Unmount, detach the volume from the helper, attach it to a
`g4dn.xlarge` as `/dev/sda1` (the root device), and start it.

```bash
sudo umount /mnt/target
```

Then terminate the helper and the throwaway instance.

### Path C: just recover the patched pipeline code (no full restore)

Often all you actually want is the hand-tuned backend, not a whole machine. You can pull
just those files out of the 30 GB archive without extracting the rest:

```bash
rclone cat r2:voicestudio-golden/golden-20260823/var-containerd.tar.zst \
  | tar -I zstd -xf - -C /tmp/recovered --wildcards \
      '*/snapshots/24/fs/app/backend/*'
```

The code lands under
`/tmp/recovered/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/24/fs/app/backend/`.

Note this still reads all 30 GB from R2 (tar can't seek), it just doesn't write it all to
disk. It takes a few minutes and costs nothing.

---

## 4. Verifying a restore

Run these on the restored machine. **All seven must pass** — these are the exact
fingerprints of the tuned pipeline, and they were checked at three separate points during
this backup: before upload, after the filesystem repair, and again on the copy stored in
R2.

```bash
# find the layer holding the patched backend
L=$(sudo find /var/lib/containerd -type d -path '*/snapshots/24/fs/app/backend' | head -1)

sudo md5sum $L/services/aligner.py        # 9b8ceef388a7ef73d5f32d93f93a7348
sudo md5sum $L/services/chirp_timing.py   # 666b37ae06e0dfef60e9ef3e66144933
sudo md5sum $L/services/fa_timing.py      # 7f299ff33429339396788535f2447e28
sudo md5sum $L/services/head_language.py  # 40f251f42504febce4b7b43cafdfbc1a
sudo md5sum $L/services/chirp_wire.py     # 15df408cc9771e4876c1220618050712

sudo stat -c %s $L/services/speech_rate.py                                  # 13073
sudo grep -cE 'lead_in|leadin|sibilant|_LEAD_IN' $L/api/routers/dub_generate.py  # 5
```

Then check the machine came up correctly:

```bash
docker ps                        # container 9276383fe31e should be running
systemctl status gemini-proxy    # must be active - it mints the Gemini tokens
nvidia-smi                       # GPU visible
free -h                          # swap ~24Gi
ls /root/.cache/huggingface/hub  # 16 model repos, ~20 GB
```

Finally, run one real dub end-to-end and listen to it. The checksums prove the code is
byte-identical; only a render proves the whole stack works.

### Reference facts about the golden machine

| | |
|---|---|
| OS | Ubuntu 22.04.5 LTS |
| Kernel | 6.8.0-1052-aws |
| Container image | `palashdeb/omnivoice-studio:latest` |
| Container ID / hostname | `9276383fe31e` |
| Disk used | 115 GB of 146 GB |
| Swap | 24 GiB at `/swapfile` |
| Root mounted by | `LABEL=cloudimg-rootfs` |
| Autostart units | `containerd`, `docker`, `gemini-proxy` |

If you ever rebuild the container from scratch rather than restoring it, pass
`--hostname 9276383fe31e`. Some cached state keys off the hostname.

---

## 5. Why the original pipeline was never at risk

The golden box was **stopped** for the whole operation and never read from directly.
Everything came from a chain of disposable copies:

1. An AMI + EBS snapshot was taken of the golden volume. Snapshots are immutable.
2. A **temporary volume** was created *from that snapshot* and attached to a separate
   worker instance, mounted **read-only**.
3. All archiving read from that temporary copy.

One wrinkle worth knowing about: the AMI was captured with `--no-reboot`, which makes it
*crash-consistent*. A dozen `.wav` files from a render that was in flight had bad inode
checksums, and they killed the 30 GB archive with `Cannot stat: Bad message`. The fix was
to run `e2fsck -f -y` — **on the disposable copy, not the original**. The golden volume
and the snapshot were untouched by this. After the repair, all seven fingerprints still
matched, and the archive completed with **zero files skipped**.

Also worth noting: `DeleteOnTermination=false` was set on the golden volume
`vol-044f2531a5977abaa`, so even an accidental terminate leaves the disk intact.

---

## 6. Keeping it cheap

At ~57.8 GiB, R2 charges about **$0.87/month**. There is no charge to download, which is
the reason R2 was chosen over S3 Glacier or GCS Archive — those are cheaper per GB but
charge retrieval fees, which makes you reluctant to ever *test* your backup. A backup you
haven't tested isn't a backup.

To re-verify at any time, at zero cost:

```bash
rclone cat r2:voicestudio-golden/golden-20260823/swapfile.tar.zst | sha256sum
# compare against MANIFEST.txt
```
