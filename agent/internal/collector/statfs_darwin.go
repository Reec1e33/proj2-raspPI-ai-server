//go:build darwin

package collector

import "syscall"

// statfs returns total, free and available bytes for the filesystem that
// holds path. On Darwin, f_bsize is the fundamental block size.
func statfs(path string) (total, free, avail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, err
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bfree * bs, st.Bavail * bs, nil
}
