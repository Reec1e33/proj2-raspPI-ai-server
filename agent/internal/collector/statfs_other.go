//go:build !linux && !darwin

package collector

import "errors"

func statfs(string) (total, free, avail uint64, err error) {
	return 0, 0, 0, errors.ErrUnsupported
}
