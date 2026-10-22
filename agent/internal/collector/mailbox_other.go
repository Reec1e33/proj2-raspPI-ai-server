//go:build !linux

package collector

import "errors"

func gencmd([]string, string) (string, error) {
	return "", errors.ErrUnsupported
}
