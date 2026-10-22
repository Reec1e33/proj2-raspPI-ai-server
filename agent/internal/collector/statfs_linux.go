//go:build linux

package collector

import "syscall"

// statfs returns total, free and available bytes for the filesystem that
// holds path. Block counts are in units of the fragment size (f_frsize).
func statfs(path string) (total, free, avail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, err
	}
	bs := uint64(st.Frsize)
	return st.Blocks * bs, st.Bfree * bs, st.Bavail * bs, nil
}
